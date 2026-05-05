import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { Doc } from "./_generated/dataModel";

export const currentUser = query({
  args: {},
  handler: async (ctx): Promise<Doc<"users"> | null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) =>
        q.eq("clerkUserId", identity.subject),
      )
      .first();
  },
});

export const getOrCreate = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) =>
        q.eq("clerkUserId", identity.subject),
      )
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("users", {
      clerkUserId: identity.subject,
      email: identity.email ?? "",
      createdAt: Date.now(),
      paidTier: false,
    });
  },
});

export const getOrCreateInternal = internalMutation({
  args: { clerkUserId: v.string(), email: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) =>
        q.eq("clerkUserId", args.clerkUserId),
      )
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("users", {
      clerkUserId: args.clerkUserId,
      email: args.email,
      createdAt: Date.now(),
      paidTier: false,
    });
  },
});

export const updateLastIngested = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, { lastIngestedAt: Date.now() });
  },
});

export const getByClerkIdInternal = internalQuery({
  args: { clerkUserId: v.string() },
  handler: async (ctx, args): Promise<Doc<"users"> | null> => {
    return await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) =>
        q.eq("clerkUserId", args.clerkUserId),
      )
      .first();
  },
});

export const listAllInternal = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"users">[]> => {
    return await ctx.db.query("users").collect();
  },
});

// Overwrites the progress doc with a fresh run. Called once by the
// classifyAllPending entrypoint before chunk 0 is scheduled.
export const initClassificationProgress = internalMutation({
  args: {
    userId: v.id("users"),
    totalToProcess: v.number(),
    startedAt: v.number(),
    mode: v.union(v.literal("pending"), v.literal("failed")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      classificationProgress: {
        totalToProcess: args.totalToProcess,
        processed: 0,
        startedAt: args.startedAt,
        classified: 0,
        failed: 0,
        inputTokens: 0,
        outputTokens: 0,
        mode: args.mode,
      },
    });
  },
});

// Atomic increment of running totals after a chunk completes. Uses
// patch-after-read so two concurrent chunks (shouldn't happen, but defensive)
// don't clobber each other's counters within a single mutation transaction.
export const applyChunkResult = internalMutation({
  args: {
    userId: v.id("users"),
    deltaProcessed: v.number(),
    deltaClassified: v.number(),
    deltaFailed: v.number(),
    deltaInputTokens: v.number(),
    deltaOutputTokens: v.number(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user || !user.classificationProgress) return;
    const p = user.classificationProgress;
    await ctx.db.patch(args.userId, {
      classificationProgress: {
        ...p,
        processed: p.processed + args.deltaProcessed,
        classified: p.classified + args.deltaClassified,
        failed: p.failed + args.deltaFailed,
        inputTokens: p.inputTokens + args.deltaInputTokens,
        outputTokens: p.outputTokens + args.deltaOutputTokens,
      },
    });
  },
});

// Stamps completedAt on the existing progress doc. Called by the last chunk.
export const markClassificationComplete = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user || !user.classificationProgress) return;
    await ctx.db.patch(args.userId, {
      classificationProgress: {
        ...user.classificationProgress,
        completedAt: Date.now(),
      },
    });
  },
});
