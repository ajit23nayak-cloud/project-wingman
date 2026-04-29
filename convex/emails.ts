"use node";

import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { listEmailsLastNDays } from "./lib/gmail";
import { getGoogleAccessToken } from "./lib/clerkBackend";

export const ingestEmails = action({
  args: {},
  handler: async (ctx): Promise<{ count: number; error?: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { count: 0, error: "not_authenticated" };
    }
    const clerkUserId = identity.subject;

    const userId = await ctx.runMutation(internal.users.getOrCreateInternal, {
      clerkUserId,
      email: identity.email ?? "",
    });

    let token: string | null;
    try {
      token = await getGoogleAccessToken(clerkUserId);
    } catch (err) {
      console.error("[ingestEmails] Clerk token fetch failed", {
        clerkUserId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { count: 0, error: "token_fetch_failed" };
    }
    if (!token) {
      return { count: 0, error: "no_google_token" };
    }

    let emails;
    try {
      emails = await listEmailsLastNDays(token, 30);
    } catch (err) {
      console.error("[ingestEmails] Gmail list failed", {
        clerkUserId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { count: 0, error: "gmail_fetch_failed" };
    }

    let newCount = 0;
    for (const email of emails) {
      const inserted: boolean = await ctx.runMutation(
        internal.inbox.insertIfNew,
        {
          userId,
          gmailMessageId: email.messageId,
          threadId: email.threadId,
          fromAddress: email.fromAddress,
          toAddresses: email.toAddresses,
          subject: email.subject,
          snippet: email.snippet,
          receivedAt: email.receivedAt.getTime(),
        },
      );
      if (inserted) newCount++;
    }

    await ctx.runMutation(internal.users.updateLastIngested, { userId });

    return { count: newCount };
  },
});
