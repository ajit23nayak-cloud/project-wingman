import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { Doc } from "./_generated/dataModel";

// Day 4: voice-sample queries + mutations live here (default Convex runtime)
// because sentMail.ts is "use node" and node modules can only export actions.

export const getVoiceSamplesByUserIdInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<Doc<"voiceSamples"> | null> => {
    return await ctx.db
      .query("voiceSamples")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
  },
});

export const hasVoiceSamplesInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<boolean> => {
    const doc = await ctx.db
      .query("voiceSamples")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
    return doc !== null && (doc.sampleSnippets?.length ?? 0) > 0;
  },
});

export const upsertVoiceSamplesInternal = internalMutation({
  args: {
    userId: v.id("users"),
    sampleSnippets: v.array(v.string()),
    sampleSnippetsByType: v.optional(
      v.array(
        v.object({
          snippet: v.string(),
          replyType: v.union(
            v.literal("ack"),
            v.literal("decline"),
            v.literal("question"),
            v.literal("propose"),
            v.literal("info"),
          ),
        }),
      ),
    ),
  },
  handler: async (ctx, args): Promise<void> => {
    const existing = await ctx.db
      .query("voiceSamples")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        sampleSnippets: args.sampleSnippets,
        sampleSnippetsByType: args.sampleSnippetsByType,
        lastUpdatedAt: now,
      });
    } else {
      await ctx.db.insert("voiceSamples", {
        userId: args.userId,
        sampleSnippets: args.sampleSnippets,
        sampleSnippetsByType: args.sampleSnippetsByType,
        lastUpdatedAt: now,
      });
    }
  },
});
