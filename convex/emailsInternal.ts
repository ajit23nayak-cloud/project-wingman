import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

// Lives in a non-node file because convex/emails.ts is "use node" (Gmail SDK
// only loads in Node runtime) and internal mutations must run in the V8 /
// Convex runtime. ingestEmails calls this via ctx.runMutation.
export const pruneToActiveCap = internalMutation({
  args: { userId: v.id("users"), targetCap: v.number() },
  handler: async (ctx, { userId, targetCap }): Promise<{ pruned: number }> => {
    const all = await ctx.db
      .query("emails")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    const active = all.filter((e) => e.archived_stale !== true);
    if (active.length <= targetCap) return { pruned: 0 };
    const sortedOldestFirst = [...active].sort(
      (a, b) => a.receivedAt - b.receivedAt,
    );
    const toPruneCount = active.length - targetCap;
    let pruned = 0;
    for (let i = 0; i < toPruneCount; i++) {
      await ctx.db.patch(sortedOldestFirst[i]._id, { archived_stale: true });
      pruned++;
    }
    return { pruned };
  },
});
