import { internalMutation, internalQuery } from "./_generated/server";
import { BACKFILL_EMAIL_CAP, STALE_AGE_DAYS } from "./lib/limits";

// Single source of truth for /debug/* surfaces. Add an email here to grant
// admin access; the gate is duplicated in voiceSamples.ts and inbox.ts via
// import, never copy-pasted.
export const ADMIN_EMAILS = ["ajit23nayak@gmail.com"];

// One-off CLI mutation to clear a stuck classificationProgress doc.
// Run via: npx convex run admin:resetClassificationProgress --prod
//
// Single-user beta — clears the field on every user doc that has one.
// When the user count grows past 1, take a userId arg.
export const resetClassificationProgress = internalMutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    let cleared = 0;
    for (const u of users) {
      if (u.classificationProgress !== undefined) {
        await ctx.db.patch(u._id, { classificationProgress: undefined });
        cleared++;
      }
    }
    return { cleared, totalUsers: users.length };
  },
});

// CLI diagnostic — current classification state across all users.
// Single-user beta so this folds counts across all rows.
export const classificationCounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const emails = await ctx.db.query("emails").collect();
    let total = 0;
    let pending = 0;
    let failed = 0;
    let urgent = 0;
    let important = 0;
    let fyi = 0;
    let archive = 0;
    for (const e of emails) {
      total++;
      if (e.classificationError !== undefined) {
        failed++;
        continue;
      }
      if (e.classification === null) {
        pending++;
        continue;
      }
      if (e.classification === "urgent") urgent++;
      else if (e.classification === "important") important++;
      else if (e.classification === "fyi") fyi++;
      else if (e.classification === "archive") archive++;
    }
    return { total, pending, failed, urgent, important, fyi, archive };
  },
});

// Day 7 email-cap: one-off CLI mutation to flag historical rows as
// archived_stale. Active set per user = (most recent BACKFILL_EMAIL_CAP rows
// by receivedAt) AND (received within STALE_AGE_DAYS). Everything else gets
// archived_stale=true.
//
// Idempotent — running twice produces the same result and only patches rows
// whose stale flag actually changes (so it doesn't churn _creationTime or
// blow up Convex's write quota on re-runs).
//
//   npx convex run admin:backfillArchivedStale --prod
export const backfillArchivedStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    const now = Date.now();
    const cutoffMs = now - STALE_AGE_DAYS * 24 * 60 * 60 * 1000;
    let totalMarkedStale = 0;
    let totalUnmarked = 0;
    const perUser: {
      userId: string;
      total: number;
      active: number;
      stale: number;
      patchedStale: number;
      patchedActive: number;
    }[] = [];

    for (const u of users) {
      const emails = await ctx.db
        .query("emails")
        .withIndex("by_userId", (q) => q.eq("userId", u._id))
        .collect();
      // Sort newest first, then take the top CAP that also pass the
      // STALE_AGE_DAYS recency gate. That intersection is the active set.
      const sorted = [...emails].sort((a, b) => b.receivedAt - a.receivedAt);
      const activeIds = new Set<string>();
      for (let i = 0; i < Math.min(BACKFILL_EMAIL_CAP, sorted.length); i++) {
        if (sorted[i].receivedAt >= cutoffMs) {
          activeIds.add(sorted[i]._id);
        }
      }

      let patchedStale = 0;
      let patchedActive = 0;
      for (const e of emails) {
        const shouldBeStale = !activeIds.has(e._id);
        const isStale = e.archived_stale === true;
        if (shouldBeStale && !isStale) {
          await ctx.db.patch(e._id, { archived_stale: true });
          patchedStale++;
        } else if (!shouldBeStale && isStale) {
          await ctx.db.patch(e._id, { archived_stale: false });
          patchedActive++;
        }
      }

      const stale = emails.length - activeIds.size;
      totalMarkedStale += patchedStale;
      totalUnmarked += patchedActive;
      perUser.push({
        userId: u._id,
        total: emails.length,
        active: activeIds.size,
        stale,
        patchedStale,
        patchedActive,
      });
    }

    return {
      usersScanned: users.length,
      totalMarkedStale,
      totalUnmarked,
      perUser,
    };
  },
});

// Day 6 voice-corpus deepening: one-off CLI mutation to drop the legacy
// singleton-per-user voiceSamples docs so the new per-row schema applies
// cleanly. Idempotent — also drops orphaned rows missing the new required
// fields. Run once after deploy:
//   npx convex run admin:clearVoiceSamples --prod
export const clearVoiceSamples = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("voiceSamples").collect();
    for (const r of rows) {
      await ctx.db.delete(r._id);
    }
    return { deleted: rows.length };
  },
});

// CLI diagnostic — recent failure errors so we can see why Gemini is rejecting.
export const recentFailureErrors = internalQuery({
  args: {},
  handler: async (ctx) => {
    const emails = await ctx.db.query("emails").collect();
    const failed = emails.filter((e) => e.classificationError !== undefined);
    const sample = failed.slice(0, 5).map((e) => ({
      _id: e._id,
      fromAddress: e.fromAddress,
      subject: e.subject.slice(0, 60),
      error: (e.classificationError ?? "").slice(0, 200),
    }));
    return { failedTotal: failed.length, sample };
  },
});
