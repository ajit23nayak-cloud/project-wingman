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

export const setClassificationProgress = internalMutation({
  args: {
    userId: v.id("users"),
    progress: v.union(
      v.object({
        totalToProcess: v.number(),
        processed: v.number(),
        startedAt: v.number(),
      }),
      v.null(),
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      classificationProgress: args.progress ?? undefined,
    });
  },
});
