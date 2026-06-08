import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import { getGoogleAccessToken } from "@/lib/clerk";
import { getMessageBody, GmailAuthError } from "@/lib/gmail";
import { draftReplyContent } from "@/lib/prompts/draftReply";
import {
  markGmailReauthNeeded,
  clearGmailReauthFlag,
} from "@/lib/auth/gmailReauth";
import { auth } from "@clerk/nextjs/server";

// POST /api/drafts/generate
//
// Body: { email_id: string }
// Returns: { ok: true, draft_id, body } on success
//          { ok: false, error: <code> } on failure (HTTP 200 unless 4xx auth)
//
// Flow:
//   1. resolveUser → Clerk session (or CRON_SECRET for CLI)
//   2. Lookup email by id, verify user_id matches
//   3. Fetch full body via Gmail (re-uses /api/emails/[id]/body's helper)
//   4. Pull voice corpus: SELECT snippet FROM voice_samples WHERE user_id =
//      LIMIT 10. v0 stub uses single pool — no segment match.
//   5. Run draftReplyContent (Gemini 2.5 Flash Lite via @ai-sdk/google)
//   6. UPSERT into drafts table (UNIQUE email_id means generate-twice
//      replaces). segment_used stays NULL per the v0 stub.

export const runtime = "nodejs";

const VOICE_CORPUS_LIMIT = 10;
const FALLBACK_FIRST_NAME = "there";

type RequestBody = { email_id?: string };

export async function POST(req: NextRequest) {
  const result = await resolveUser(req);
  if (!result.ok) return result.response;
  const { supabaseUserId, clerkUserId } = result.user;

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.email_id !== "string" || body.email_id.length === 0) {
    return NextResponse.json(
      { error: "email_id_required" },
      { status: 400 },
    );
  }

  const supabase = makeSupabaseServerClient();

  // Lookup the email — must belong to this user.
  const { data: emailRow, error: emailErr } = await supabase
    .from("emails")
    .select("id, gmail_message_id, from_address, subject, snippet")
    .eq("id", body.email_id)
    .eq("user_id", supabaseUserId)
    .maybeSingle();
  if (emailErr) {
    console.error("[drafts/generate] email select failed", {
      message: emailErr.message,
    });
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
  if (!emailRow) {
    return NextResponse.json({ error: "email_not_found" }, { status: 404 });
  }

  // Gmail token.
  let token: string | null;
  try {
    token = await getGoogleAccessToken(clerkUserId);
  } catch (err) {
    console.error("[drafts/generate] Clerk token fetch failed", {
      clerkUserId,
      message: err instanceof Error ? err.message : String(err),
    });
    await markGmailReauthNeeded(supabase, supabaseUserId);
    return NextResponse.json(
      { ok: false, error: "token_fetch_failed" },
      { status: 412 },
    );
  }
  if (!token) {
    await markGmailReauthNeeded(supabase, supabaseUserId);
    return NextResponse.json(
      { ok: false, error: "no_google_token" },
      { status: 412 },
    );
  }

  // Fetch the full body. Fall back to snippet on error — the prompt still
  // generates something usable.
  let bodyText: string = emailRow.snippet ?? "";
  try {
    const fetched = await getMessageBody(token, emailRow.gmail_message_id);
    if (fetched.bodyText && fetched.bodyText.trim().length > 0) {
      bodyText = fetched.bodyText;
    }
    await clearGmailReauthFlag(supabase, supabaseUserId);
  } catch (err) {
    if (err instanceof GmailAuthError) {
      await markGmailReauthNeeded(supabase, supabaseUserId);
      return NextResponse.json(
        { ok: false, error: "gmail_auth_failed" },
        { status: 412 },
      );
    }
    console.warn("[drafts/generate] body fetch failed, using snippet", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // Voice corpus — single pool, no segment match (v0 stub). LIMIT 10 by
  // recency. If empty, draftReplyContent falls back to the "no prior
  // samples" prompt branch.
  const { data: voiceRows, error: voiceErr } = await supabase
    .from("voice_samples")
    .select("snippet")
    .eq("user_id", supabaseUserId)
    .order("sent_at", { ascending: false })
    .limit(VOICE_CORPUS_LIMIT);
  if (voiceErr) {
    console.warn("[drafts/generate] voice samples select failed", {
      message: voiceErr.message,
    });
  }
  const voiceSnippets = (voiceRows ?? []).map((r) => r.snippet);

  // First name from Clerk session — used to personalize the system prompt.
  const session = await auth();
  const firstName =
    (session.sessionClaims?.firstName as string | undefined) ??
    (session.sessionClaims?.first_name as string | undefined) ??
    FALLBACK_FIRST_NAME;

  // Generate.
  let draftText: string;
  let usage: { inputTokens?: number; outputTokens?: number };
  try {
    const out = await draftReplyContent({
      userFirstName: firstName,
      voiceSnippets,
      fromAddress: emailRow.from_address,
      subject: emailRow.subject,
      bodyText,
    });
    draftText = out.text;
    usage = { inputTokens: out.usage.inputTokens, outputTokens: out.usage.outputTokens };
  } catch (err) {
    console.error("[drafts/generate] LLM call failed", {
      emailId: emailRow.id,
      message: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: "llm_failed" },
      { status: 502 },
    );
  }
  if (!draftText || draftText.length === 0) {
    return NextResponse.json(
      { ok: false, error: "empty_draft" },
      { status: 502 },
    );
  }

  // Upsert the draft row.
  const now = Date.now();
  const { data: draftRow, error: upsertErr } = await supabase
    .from("drafts")
    .upsert(
      {
        email_id: emailRow.id,
        user_id: supabaseUserId,
        body: draftText,
        generated_at: now,
        edited_at: null,
        segment_used: null,
        snippet_indices_used: [],
        status: "unsent",
        reply_message_id: null,
        replied_at: null,
      },
      { onConflict: "email_id" },
    )
    .select("id, body")
    .single();
  if (upsertErr || !draftRow) {
    console.error("[drafts/generate] upsert failed", {
      emailId: emailRow.id,
      message: upsertErr?.message ?? "no row returned",
    });
    return NextResponse.json(
      { ok: false, error: "upsert_failed" },
      { status: 500 },
    );
  }

  console.log("[drafts/generate] done", {
    emailId: emailRow.id,
    draftId: draftRow.id,
    chars: draftText.length,
    voiceSnippets: voiceSnippets.length,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });

  return NextResponse.json({
    ok: true,
    draft_id: draftRow.id,
    body: draftRow.body,
  });
}
