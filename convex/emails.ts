"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { listEmailsLastNDays } from "./lib/gmail";
import { getGoogleAccessToken } from "./lib/clerkBackend";
import {
  BACKFILL_EMAIL_CAP,
  STALE_BUFFER,
  INITIAL_LOOKBACK_DAYS,
} from "./lib/limits";
import { Id } from "./_generated/dataModel";

export const ingestEmails = action({
  // Optional userEmail is a CLI-only disambiguator: when the caller has no
  // Clerk identity AND there are 2+ users in the table, the operator must
  // pass --user-email to pick the target. Mirrors the sentMail single-user
  // fallback shape but extends it for the post-beta multi-user case.
  args: { userEmail: v.optional(v.string()) },
  handler: async (
    ctx,
    { userEmail },
  ): Promise<{ count: number; error?: string }> => {
    const identity = await ctx.auth.getUserIdentity();

    let userId: Id<"users">;
    let clerkUserId: string;

    if (identity) {
      clerkUserId = identity.subject;
      userId = await ctx.runMutation(internal.users.getOrCreateInternal, {
        clerkUserId,
        email: identity.email ?? "",
      });
    } else if (userEmail) {
      const target = await ctx.runQuery(internal.users.getByEmailInternal, {
        email: userEmail,
      });
      if (!target) {
        return {
          count: 0,
          error: `user_not_found_for_email (${userEmail})`,
        };
      }
      userId = target._id;
      clerkUserId = target.clerkUserId;
    } else {
      const all = await ctx.runQuery(internal.users.listAllInternal, {});
      if (all.length !== 1) {
        return {
          count: 0,
          error: `not_authenticated_and_cli_fallback_requires_1_user_or_userEmail (found ${all.length})`,
        };
      }
      userId = all[0]._id;
      clerkUserId = all[0].clerkUserId;
    }

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
      emails = await listEmailsLastNDays(
        token,
        INITIAL_LOOKBACK_DAYS,
        BACKFILL_EMAIL_CAP,
      );
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

    // Day 7 auto-prune: if active pool drifted past CAP + BUFFER, flag the
    // oldest active rows archived_stale so the inbox stays bounded. Wrapped
    // because a prune failure must never block a successful ingest.
    try {
      const beforeActive: number = await ctx.runQuery(
        internal.inbox.countActiveForUserInternal,
        { userId },
      );
      if (beforeActive > BACKFILL_EMAIL_CAP + STALE_BUFFER) {
        const { pruned } = await ctx.runMutation(
          internal.emailsInternal.pruneToActiveCap,
          { userId, targetCap: BACKFILL_EMAIL_CAP },
        );
        const afterActive = beforeActive - pruned;
        console.log("[ingestEmails] pruned to cap", {
          userId,
          beforeActive,
          afterActive,
          pruned,
        });
      }
    } catch (err) {
      console.error("[ingestEmails] prune failed", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Day 4: on first ingest (or if voice samples were never gathered),
    // schedule the sent-mail sample collection so draft-reply has a voice to
    // mimic. Wrapped in try/catch — a sample-ingest failure must never break
    // ingestEmails itself.
    try {
      const hasSamples: boolean = await ctx.runQuery(
        internal.voiceSamples.hasAnyVoiceSamplesInternal,
        { userId },
      );
      if (!hasSamples) {
        await ctx.scheduler.runAfter(
          0,
          internal.sentMail.ingestSentMailSamplesInternal,
          { userId, clerkUserId },
        );
      }
    } catch (err) {
      console.error("[ingestEmails] voice-sample schedule failed", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return { count: newCount };
  },
});
