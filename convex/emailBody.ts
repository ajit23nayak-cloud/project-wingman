"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { getMessageBody } from "./lib/gmail";
import { getGoogleAccessToken } from "./lib/clerkBackend";

/**
 * Decode a small set of common HTML entities used in plain prose.
 * Sufficient for "show this email body" — not a real HTML parser.
 */
function decodeBasicHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

/**
 * Crude HTML → text fallback for messages that ship HTML only. Strips tags,
 * decodes the common entities, collapses whitespace. Good enough for a
 * detail-view preview; the LLM (Agent A's draftReply) reads this too.
 */
function htmlToTextFallback(html: string): string {
  const cleaned = html
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ");
  const stripped = cleaned.replace(/<[^>]+>/g, " ");
  const decoded = decodeBasicHtmlEntities(stripped);
  return decoded.replace(/\s+/g, " ").trim();
}

/**
 * Public action — fetches the full body of an email on demand. Used by the
 * detail view (Agent C) AND by Agent A's draftReply via ctx.runAction (auth
 * propagates through subactions). Returning a soft error instead of throwing
 * keeps the UI in control of how to render auth/network failures.
 */
export const fetchEmailBody = action({
  args: { emailId: v.id("emails") },
  handler: async (
    ctx,
    { emailId },
  ): Promise<{ bodyText: string; error?: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { bodyText: "", error: "not_authenticated" };
    const clerkUserId = identity.subject;

    const user = await ctx.runQuery(internal.users.getByClerkIdInternal, {
      clerkUserId,
    });
    if (!user) return { bodyText: "", error: "user_not_found" };

    const email = await ctx.runQuery(internal.inbox.getEmailByIdInternal, {
      emailId,
    });
    if (!email) return { bodyText: "", error: "email_not_found" };
    if (email.userId !== user._id) {
      return { bodyText: "", error: "forbidden" };
    }

    let token: string | null;
    try {
      token = await getGoogleAccessToken(clerkUserId);
    } catch (err) {
      console.error("[fetchEmailBody] Clerk token fetch failed", {
        clerkUserId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { bodyText: "", error: "token_fetch_failed" };
    }
    if (!token) return { bodyText: "", error: "no_google_token" };

    try {
      const { bodyText, bodyHtml } = await getMessageBody(
        token,
        email.gmailMessageId,
      );
      const text =
        bodyText && bodyText.trim().length > 0
          ? bodyText
          : bodyHtml
            ? htmlToTextFallback(bodyHtml)
            : "";
      return { bodyText: text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[fetchEmailBody] Gmail fetch failed", {
        emailId,
        error: msg,
      });
      return { bodyText: "", error: msg };
    }
  },
});
