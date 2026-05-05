import { internalMutation, internalQuery } from "./_generated/server";

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
