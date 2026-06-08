import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import { getGoogleAccessToken } from "@/lib/clerk";
import { getMessageBody, GmailAuthError } from "@/lib/gmail";
import {
  markGmailReauthNeeded,
  clearGmailReauthFlag,
} from "@/lib/auth/gmailReauth";

// GET /api/emails/[id]/body
//
// Returns the full body of a single email — Gmail fetched fresh on demand
// (we don't cache bodies in Supabase; only metadata + snippet). Used by the
// /email/[id] detail page and, in commit B, by the draft generator.
//
// Mirrors convex/emailBody.ts:fetchEmailBody. Errors come back as a soft
// `{ bodyText: "", error: "<code>" }` rather than HTTP failure codes — the
// UI controls how to render auth/network problems and we want graceful
// degradation (snippet fallback) instead of an error boundary.
//
// On Clerk-token failure or mid-call GmailAuthError, we mark
// gmail_reauth_needed so the dashboard banner fires. On any successful
// Gmail fetch we self-clear the flag (strategy ii).

export const runtime = "nodejs";

function decodeBasicHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

// Crude HTML → text fallback for messages that ship HTML only. Good enough
// for a detail-view preview; not a real HTML parser. Ported verbatim from
// convex/emailBody.ts.
function htmlToTextFallback(html: string): string {
  const cleaned = html
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ");
  const stripped = cleaned.replace(/<[^>]+>/g, " ");
  const decoded = decodeBasicHtmlEntities(stripped);
  return decoded.replace(/\s+/g, " ").trim();
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const result = await resolveUser(req);
  if (!result.ok) return result.response;
  const { supabaseUserId, clerkUserId } = result.user;

  const supabase = makeSupabaseServerClient();

  // Lookup the email — must belong to this user. The RLS policy would enforce
  // this on a browser-direct read; here we use service_role + explicit filter
  // because we need to fetch from Gmail next (server-side context).
  const { data: emailRow, error: emailErr } = await supabase
    .from("emails")
    .select("id, gmail_message_id, user_id, snippet")
    .eq("id", id)
    .eq("user_id", supabaseUserId)
    .maybeSingle();
  if (emailErr) {
    console.error("[emails/body] select failed", {
      id,
      message: emailErr.message,
    });
    return NextResponse.json(
      { bodyText: "", error: "lookup_failed" },
      { status: 500 },
    );
  }
  if (!emailRow) {
    return NextResponse.json(
      { bodyText: "", error: "email_not_found" },
      { status: 404 },
    );
  }

  let token: string | null;
  try {
    token = await getGoogleAccessToken(clerkUserId);
  } catch (err) {
    console.error("[emails/body] Clerk token fetch failed", {
      clerkUserId,
      message: err instanceof Error ? err.message : String(err),
    });
    await markGmailReauthNeeded(supabase, supabaseUserId);
    return NextResponse.json({
      bodyText: emailRow.snippet ?? "",
      error: "token_fetch_failed",
    });
  }
  if (!token) {
    await markGmailReauthNeeded(supabase, supabaseUserId);
    return NextResponse.json({
      bodyText: emailRow.snippet ?? "",
      error: "no_google_token",
    });
  }

  try {
    const { bodyText, bodyHtml } = await getMessageBody(
      token,
      emailRow.gmail_message_id,
    );
    const text =
      bodyText && bodyText.trim().length > 0
        ? bodyText
        : bodyHtml
          ? htmlToTextFallback(bodyHtml)
          : "";
    // Gmail call succeeded — OAuth is healthy. Self-clear the reauth flag
    // (strategy ii for out-of-band reconnects).
    await clearGmailReauthFlag(supabase, supabaseUserId);
    return NextResponse.json({ bodyText: text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[emails/body] Gmail fetch failed", {
      id,
      message: msg,
    });
    if (err instanceof GmailAuthError) {
      await markGmailReauthNeeded(supabase, supabaseUserId);
      return NextResponse.json({
        bodyText: emailRow.snippet ?? "",
        error: "gmail_auth_failed",
      });
    }
    return NextResponse.json({
      bodyText: emailRow.snippet ?? "",
      error: "gmail_fetch_failed",
    });
  }
}
