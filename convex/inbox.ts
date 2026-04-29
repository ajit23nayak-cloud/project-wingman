import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { Doc } from "./_generated/dataModel";

export const listRecent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Doc<"emails">[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) =>
        q.eq("clerkUserId", identity.subject),
      )
      .first();
    if (!user) return [];
    const limit = args.limit ?? 20;
    const emails = await ctx.db
      .query("emails")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .collect();
    emails.sort((a, b) => b.receivedAt - a.receivedAt);
    return emails.slice(0, limit);
  },
});

export const countForUser = query({
  args: {},
  handler: async (ctx): Promise<number> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return 0;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) =>
        q.eq("clerkUserId", identity.subject),
      )
      .first();
    if (!user) return 0;
    const emails = await ctx.db
      .query("emails")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .collect();
    return emails.length;
  },
});

export const insertIfNew = internalMutation({
  args: {
    userId: v.id("users"),
    gmailMessageId: v.string(),
    threadId: v.string(),
    fromAddress: v.string(),
    toAddresses: v.array(v.string()),
    subject: v.string(),
    snippet: v.string(),
    receivedAt: v.number(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const existing = await ctx.db
      .query("emails")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .filter((q) => q.eq(q.field("gmailMessageId"), args.gmailMessageId))
      .first();
    if (existing) return false;
    await ctx.db.insert("emails", {
      ...args,
      classification: null,
      draftReply: null,
      status: "pending",
    });
    return true;
  },
});
