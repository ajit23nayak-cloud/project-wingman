import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import { getGoogleAccessToken } from "@/lib/clerk";
import {
  downloadAttachment,
  getMessageBodyAndAttachments,
  GmailAuthError,
} from "@/lib/gmail";
import {
  markGmailReauthNeeded,
  clearGmailReauthFlag,
} from "@/lib/auth/gmailReauth";

// GET /api/emails/[id]/attachments/[attachmentId]
//
// Streams a single Gmail attachment's bytes back to the browser as a
// downloadable file. Ownership is verified by looking up the emails row
// with user_id = supabaseUserId (mirrors body/route.ts).
//
// Why fetch the parent message: Gmail's attachments.get does NOT include
// filename or mimeType — those live on the parent message's MessagePart.
// We need both to set Content-Type and Content-Disposition correctly, so
// we fetch the parent message first, find the matching attachment entry,
// then download bytes by attachmentId.
//
// Error handling mirrors body/route.ts: token failure → markGmailReauthNeeded
// + 401 JSON; GmailAuthError → 401; other → 500.

export const runtime = "nodejs";

// RFC 5987 / 6266 safe filename: strip CR/LF so we can't smuggle headers,
// and percent-encode any double quotes / backslashes that would break the
// quoted-string syntax in Content-Disposition. The fallback name is used
// when sanitisation strips everything (extremely defensive — Gmail
// filenames always come back with at least one printable char).
function sanitizeFilename(name: string): string {
  const stripped = name.replace(/[\r\n]+/g, "").trim();
  if (!stripped) return "attachment";
  return stripped.replace(/["\\]/g, (c) =>
    c === '"' ? "%22" : "%5C",
  );
}

export async function GET(
  req: NextRequest,
  {
    params,
  }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  const { id, attachmentId } = await params;

  const result = await resolveUser(req);
  if (!result.ok) return result.response;
  const { supabaseUserId, clerkUserId } = result.user;

  const supabase = makeSupabaseServerClient();

  // Verify ownership: the email row must belong to this user. Service-role
  // client bypasses RLS — explicit eq("user_id") is the gate here.
  const { data: emailRow, error: emailErr } = await supabase
    .from("emails")
    .select("id, gmail_message_id, user_id")
    .eq("id", id)
    .eq("user_id", supabaseUserId)
    .maybeSingle();
  if (emailErr) {
    console.error("[emails/attachments] select failed", {
      id,
      message: emailErr.message,
    });
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
  if (!emailRow) {
    return NextResponse.json({ error: "email_not_found" }, { status: 404 });
  }

  let token: string | null;
  try {
    token = await getGoogleAccessToken(clerkUserId);
  } catch (err) {
    console.error("[emails/attachments] Clerk token fetch failed", {
      clerkUserId,
      message: err instanceof Error ? err.message : String(err),
    });
    await markGmailReauthNeeded(supabase, supabaseUserId);
    return NextResponse.json(
      { error: "token_fetch_failed" },
      { status: 401 },
    );
  }
  if (!token) {
    await markGmailReauthNeeded(supabase, supabaseUserId);
    return NextResponse.json({ error: "no_google_token" }, { status: 401 });
  }

  try {
    // Look up attachment metadata from the parent message so we know the
    // filename + mimeType to attach to the response headers.
    const { attachments } = await getMessageBodyAndAttachments(
      token,
      emailRow.gmail_message_id,
    );
    const meta = attachments.find((a) => a.attachmentId === attachmentId);
    if (!meta) {
      return NextResponse.json(
        { error: "attachment_not_found" },
        { status: 404 },
      );
    }

    const { data } = await downloadAttachment(
      token,
      emailRow.gmail_message_id,
      attachmentId,
    );

    // Gmail call succeeded — OAuth is healthy. Self-clear the reauth flag
    // (mirrors body/route.ts strategy ii for out-of-band reconnects).
    await clearGmailReauthFlag(supabase, supabaseUserId);

    const safeName = sanitizeFilename(meta.filename);
    const mimeType = meta.mimeType || "application/octet-stream";

    // Copy into a fresh Uint8Array (ArrayBuffer-backed) so NextResponse
    // accepts it as a BodyInit. Node Buffer.buffer is ArrayBufferLike,
    // which TypeScript narrows away from ArrayBuffer in strict mode.
    const body = Uint8Array.from(data);

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `attachment; filename="${safeName}"`,
        "Content-Length": String(data.byteLength),
        "Cache-Control": "private, max-age=0, no-store",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[emails/attachments] Gmail fetch failed", {
      id,
      attachmentId,
      message: msg,
    });
    if (err instanceof GmailAuthError) {
      await markGmailReauthNeeded(supabase, supabaseUserId);
      return NextResponse.json(
        { error: "gmail_auth_failed" },
        { status: 401 },
      );
    }
    return NextResponse.json(
      { error: "gmail_fetch_failed" },
      { status: 500 },
    );
  }
}
