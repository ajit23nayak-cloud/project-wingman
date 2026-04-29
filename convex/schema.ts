import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    clerkUserId: v.string(),
    email: v.string(),
    // Encrypted at the application layer before insert.
    googleAccessToken: v.optional(v.string()),
    googleRefreshToken: v.optional(v.string()),
    createdAt: v.number(),
    paidTier: v.boolean(),
    paidTierExpiresAt: v.optional(v.number()),
    lastIngestedAt: v.optional(v.number()),
  }).index("by_clerkUserId", ["clerkUserId"]),

  emails: defineTable({
    userId: v.id("users"),
    gmailMessageId: v.string(),
    threadId: v.string(),
    fromAddress: v.string(),
    toAddresses: v.array(v.string()),
    subject: v.string(),
    snippet: v.string(),
    receivedAt: v.number(),
    classification: v.union(
      v.literal("urgent"),
      v.literal("important"),
      v.literal("fyi"),
      v.literal("archive"),
      v.null(),
    ),
    classificationReason: v.optional(v.string()),
    draftReply: v.union(v.string(), v.null()),
    draftReplyEditedAt: v.optional(v.number()),
    processedAt: v.optional(v.number()),
    status: v.union(
      v.literal("pending"),
      v.literal("processed"),
      v.literal("failed"),
    ),
  }).index("by_userId", ["userId"]),

  voiceProfiles: defineTable({
    userId: v.id("users"),
    sampleEmails: v.array(v.id("emails")),
    fineTunedAt: v.optional(v.number()),
    lastUpdatedAt: v.number(),
  }).index("by_userId", ["userId"]),
});
