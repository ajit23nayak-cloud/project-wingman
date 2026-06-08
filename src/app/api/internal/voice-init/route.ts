import { NextRequest, NextResponse } from "next/server";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import { getGoogleAccessToken } from "@/lib/clerk";
import {
  listSentMessagesLastNDays,
  GmailAuthError,
  type SentMessage,
} from "@/lib/gmail";
import { markGmailReauthNeeded } from "@/lib/auth/gmailReauth";

// POST /api/internal/voice-init
//
// V0 STUB of the voice corpus capture pipeline. Fires once per new user from
// /api/ingest-emails (via waitUntil) when their voice_samples row count is 0.
// Fetches the last 30 days of sent mail and inserts up to VOICE_CORPUS_MAX
// rows into public.voice_samples.
//
// "STUB" per Tab 2's v0 spec: NO segmentation classifier. The Convex version
// classified each sample into one of {cold_outreach, internal_team,
// investor_ish, casual_peer} so drafts could match relationship voice. v0
// uses a single-pool corpus — every sample is tagged with the same sentinel
// segment so migration 0002's NOT NULL constraints on voice_samples.segment
// and .reply_type still pass.
//
// Sentinels:
//   segment              = 'internal_team' (Ajit's most-populated segment in
//                          the pre-Supabase Convex corpus, so the prompt
//                          conditioning still produces a usable voice match)
//   reply_type           = 'ack'
//   segment_confidence   = 0     (signal to the v1 segmentation backfill job
//                                 that this row was stubbed, not classified)
//
// When v1 segmentation lands, a reclassify-voice-samples cron sweeps rows
// with segment_confidence = 0 and replaces the sentinel with the real
// segment + confidence. Until then, draft generation pulls from this single
// pool indiscriminately.
//
// Auth: CRON_SECRET via Bearer (same pattern as /api/cron/*). Called from
// /api/ingest-emails via waitUntil after first ingest succeeds.

export const runtime = "nodejs";

const VOICE_CORPUS_LOOKBACK_DAYS = 30;
const VOICE_CORPUS_MAX = 30;
const MIN_SNIPPET_CHARS = 40;

type RequestBody = {
  user_email?: string;
};

export async function POST(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!expected || authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.user_email !== "string" || body.user_email.length === 0) {
    return NextResponse.json(
      { error: "user_email_required" },
      { status: 400 },
    );
  }

  const supabase = makeSupabaseServerClient();

  // Resolve user by email — voice-init is fire-and-forget from ingest, so we
  // re-lookup rather than pass the supabaseUserId through query params.
  const { data: userRow, error: userErr } = await supabase
    .from("users")
    .select("id, clerk_user_id")
    .eq("email", body.user_email)
    .maybeSingle();
  if (userErr || !userRow) {
    console.error("[voice-init] user lookup failed", {
      user_email: body.user_email,
      message: userErr?.message ?? "not_found",
    });
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }

  // Skip if voice corpus already populated (idempotent — ingest fires this
  // every time but we only do the work on a genuinely empty corpus).
  const { count: existingCount } = await supabase
    .from("voice_samples")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userRow.id);
  if ((existingCount ?? 0) > 0) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "already_populated",
      existingCount,
    });
  }

  // Fetch Gmail token.
  let token: string | null;
  try {
    token = await getGoogleAccessToken(userRow.clerk_user_id);
  } catch (err) {
    console.error("[voice-init] Clerk token fetch failed", {
      userId: userRow.id,
      message: err instanceof Error ? err.message : String(err),
    });
    await markGmailReauthNeeded(supabase, userRow.id);
    return NextResponse.json(
      { error: "token_fetch_failed" },
      { status: 502 },
    );
  }
  if (!token) {
    await markGmailReauthNeeded(supabase, userRow.id);
    return NextResponse.json(
      { error: "no_google_token" },
      { status: 412 },
    );
  }

  // Fetch sent mail.
  let sent: SentMessage[];
  try {
    sent = await listSentMessagesLastNDays(
      token,
      VOICE_CORPUS_LOOKBACK_DAYS,
      VOICE_CORPUS_MAX,
    );
  } catch (err) {
    if (err instanceof GmailAuthError) {
      await markGmailReauthNeeded(supabase, userRow.id);
      return NextResponse.json(
        { error: "gmail_auth_failed" },
        { status: 412 },
      );
    }
    console.error("[voice-init] Gmail sent fetch failed", {
      userId: userRow.id,
      message: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "gmail_fetch_failed" },
      { status: 502 },
    );
  }

  if (sent.length === 0) {
    return NextResponse.json({
      ok: true,
      ingested: 0,
      reason: "no_sent_in_window",
    });
  }

  // Build rows. Skip messages with snippets shorter than MIN_SNIPPET_CHARS —
  // they're usually one-line acks, not useful voice samples.
  const ingestedAt = Date.now();
  const rows = sent
    .filter((s) => s.bodyText.trim().length >= MIN_SNIPPET_CHARS)
    .map((s) => ({
      user_id: userRow.id,
      gmail_message_id: s.messageId,
      snippet: s.bodyText.slice(0, 2000),
      subject: s.subject,
      reply_type: "ack" as const,
      segment: "internal_team" as const,
      segment_confidence: 0,
      sent_at: s.sentAt,
      ingested_at: ingestedAt,
    }));

  if (rows.length === 0) {
    return NextResponse.json({
      ok: true,
      ingested: 0,
      reason: "all_filtered_too_short",
    });
  }

  const { error: insertErr, count: insertedCount } = await supabase
    .from("voice_samples")
    .upsert(rows, {
      onConflict: "user_id,gmail_message_id",
      ignoreDuplicates: true,
      count: "exact",
    });
  if (insertErr) {
    console.error("[voice-init] insert failed", {
      userId: userRow.id,
      rowCount: rows.length,
      message: insertErr.message,
    });
    return NextResponse.json(
      { error: "insert_failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    ingested: insertedCount ?? 0,
    attempted: rows.length,
  });
}
