"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { sendReply } from "./lib/gmail";
import { getGoogleAccessToken } from "./lib/clerkBackend";

/**
 * Send the stored draftReply for an email out via Gmail. Updates the email
 * row's reply lifecycle on success (replyStatus="sent", repliedAt, replyMessageId).
 *
 * Returns a discriminated-ish shape so the frontend can distinguish auth /
 * token / state errors from generic Gmail failures without throwing.
 */
export const sendReplyAction = action({
  args: { emailId: v.id("emails") },
  handler: async (
    ctx,
    { emailId },
  ): Promise<{ success: boolean; messageId?: string; error?: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { success: false, error: "not_authenticated" };
    const clerkUserId = identity.subject;

    const user = await ctx.runQuery(internal.users.getByClerkIdInternal, {
      clerkUserId,
    });
    if (!user) return { success: false, error: "user_not_found" };

    const email = await ctx.runQuery(internal.inbox.getEmailByIdInternal, {
      emailId,
    });
    if (!email) return { success: false, error: "email_not_found" };
    if (email.userId !== user._id) {
      return { success: false, error: "forbidden" };
    }
    if (!email.draftReply || email.draftReply.trim().length === 0) {
      return { success: false, error: "no_draft" };
    }
    if (email.replyStatus !== "unsent") {
      return { success: false, error: "not_unsent" };
    }

    let token: string | null;
    try {
      token = await getGoogleAccessToken(clerkUserId);
    } catch (err) {
      console.error("[sendReplyAction] Clerk token fetch failed", {
        clerkUserId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { success: false, error: "token_fetch_failed" };
    }
    if (!token) return { success: false, error: "no_google_token" };

    // Reply From: us, To: original sender. If we don't know our own address,
    // let Gmail substitute by passing "me".
    const userEmail = identity.email ?? user.email ?? "me";

    let result;
    try {
      result = await sendReply(token, {
        threadId: email.threadId,
        toAddress: email.fromAddress,
        fromAddress: userEmail,
        subject: email.subject,
        replyBody: email.draftReply,
        inReplyToMessageId: email.gmailMessageId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[sendReplyAction] Gmail send failed", {
        emailId,
        error: msg,
      });
      return { success: false, error: msg };
    }

    // Gmail succeeded — the message has been delivered. If the row update
    // fails, the user has still successfully replied, so we report success.
    // Convex retries the mutation transparently in most transient cases; a
    // hard failure here means the dashboard "sent" badge will lag, not that
    // the reply was lost.
    try {
      await ctx.runMutation(internal.inbox.markReplySent, {
        emailId,
        gmailMessageId: result.messageId,
        repliedAt: Date.now(),
      });
    } catch (err) {
      console.error("[sendReplyAction] markReplySent failed after send", {
        emailId,
        gmailMessageId: result.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return { success: true, messageId: result.messageId };
  },
});
