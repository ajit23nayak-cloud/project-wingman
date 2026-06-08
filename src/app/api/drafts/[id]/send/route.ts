import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import { getGoogleAccessToken } from "@/lib/clerk";
import {
  assembleReplyMime,
  sendReply,
  GmailAuthError,
} from "@/lib/gmail";
import {
  markGmailReauthNeeded,
  clearGmailReauthFlag,
} from "@/lib/auth/gmailReauth";

// POST /api/drafts/[id]/send         — send the reply via Gmail
// POST /api/drafts/[id]/send?dry_run=1 — assemble MIME + validate auth/state
//                                        but skip gmail.users.messages.send.
//                                        Returns the first 200 chars of the
//                                        raw MIME for inspection. Used by
//                                        Tab 2's curl smoke test in CI;
//                                        never used in product UI.
//
// State machine:
//   draft.status='unsent' → fire send → 'sent' + reply_message_id + replied_at
//   draft.status='sent'  → 409 (already sent — duplicate-send guard)
//   no draft for this id → 404

export const runtime = "nodejs";

type DraftJoinEmail = {
  id: string;
  body: string;
  status: "unsent" | "sent";
  emails: {
    id: string;
    gmail_message_id: string;
    thread_id: string;
    from_address: string;
    subject: string;
  } | null;
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const dryRun = req.nextUrl.searchParams.get("dry_run") === "1";

  const result = await resolveUser(req);
  if (!result.ok) return result.response;
  const { supabaseUserId, clerkUserId, email: userEmail } = result.user;

  const supabase = makeSupabaseServerClient();

  // Lookup draft + joined email in one shot. PostgREST embed: emails table
  // FK draft.email_id → emails.id is many-to-one (drafts.email_id is unique,
  // but as the inner side of the relation it returns a single object or
  // null per CONVENTIONS.md "Embedded resources rule").
  const { data: row, error: lookupErr } = await supabase
    .from("drafts")
    .select(
      "id, body, status, emails(id, gmail_message_id, thread_id, from_address, subject)",
    )
    .eq("id", id)
    .eq("user_id", supabaseUserId)
    .maybeSingle();
  if (lookupErr) {
    console.error("[drafts/send] lookup failed", {
      id,
      message: lookupErr.message,
    });
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
  const draft = row as unknown as DraftJoinEmail | null;
  if (!draft || !draft.emails) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (draft.status === "sent") {
    return NextResponse.json({ error: "already_sent" }, { status: 409 });
  }
  if (!draft.body || draft.body.trim().length === 0) {
    return NextResponse.json({ error: "empty_draft" }, { status: 400 });
  }

  // Gmail token.
  let token: string | null;
  try {
    token = await getGoogleAccessToken(clerkUserId);
  } catch (err) {
    console.error("[drafts/send] Clerk token fetch failed", {
      clerkUserId,
      message: err instanceof Error ? err.message : String(err),
    });
    await markGmailReauthNeeded(supabase, supabaseUserId);
    return NextResponse.json(
      { error: "token_fetch_failed" },
      { status: 412 },
    );
  }
  if (!token) {
    await markGmailReauthNeeded(supabase, supabaseUserId);
    return NextResponse.json(
      { error: "no_google_token" },
      { status: 412 },
    );
  }

  // Dry-run branch: assemble the MIME end-to-end but skip the actual send.
  // We still hit Gmail for threading headers (so we exercise the OAuth +
  // network path), then return a preview.
  if (dryRun) {
    try {
      const { raw, haveMessageId } = await assembleReplyMime(token, {
        toAddress: draft.emails.from_address,
        fromAddress: userEmail ?? "me",
        subject: draft.emails.subject,
        replyBody: draft.body,
        inReplyToMessageId: draft.emails.gmail_message_id,
      });
      await clearGmailReauthFlag(supabase, supabaseUserId);
      return NextResponse.json({
        ok: true,
        dryRun: true,
        haveMessageId,
        mimeBytes: raw.length,
        mimePreview: raw.slice(0, 200),
      });
    } catch (err) {
      if (err instanceof GmailAuthError) {
        await markGmailReauthNeeded(supabase, supabaseUserId);
        return NextResponse.json(
          { error: "gmail_auth_failed" },
          { status: 412 },
        );
      }
      console.error("[drafts/send dry_run] mime assembly failed", {
        id,
        message: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        { error: "mime_assembly_failed" },
        { status: 502 },
      );
    }
  }

  // Real send.
  let sent: { messageId: string; threadId: string };
  try {
    sent = await sendReply(token, {
      threadId: draft.emails.thread_id,
      toAddress: draft.emails.from_address,
      fromAddress: userEmail ?? "me",
      subject: draft.emails.subject,
      replyBody: draft.body,
      inReplyToMessageId: draft.emails.gmail_message_id,
    });
  } catch (err) {
    if (err instanceof GmailAuthError) {
      await markGmailReauthNeeded(supabase, supabaseUserId);
      return NextResponse.json(
        { error: "gmail_auth_failed" },
        { status: 412 },
      );
    }
    console.error("[drafts/send] gmail send failed", {
      id,
      message: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "gmail_send_failed" },
      { status: 502 },
    );
  }

  // Gmail accepted the reply. Flip the draft to sent. If THIS UPDATE fails,
  // the message has still been delivered — log loudly and return success so
  // the user doesn't re-click Send. The dashboard's ✓ chip will lag but the
  // recipient already has the reply.
  await clearGmailReauthFlag(supabase, supabaseUserId);
  const { error: updErr } = await supabase
    .from("drafts")
    .update({
      status: "sent",
      reply_message_id: sent.messageId,
      replied_at: Date.now(),
    })
    .eq("id", id);
  if (updErr) {
    console.error(
      "[drafts/send] post-send update failed (message WAS sent)",
      {
        id,
        gmailMessageId: sent.messageId,
        message: updErr.message,
      },
    );
  }

  return NextResponse.json({
    ok: true,
    messageId: sent.messageId,
    threadId: sent.threadId,
  });
}
