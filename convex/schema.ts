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
    classificationProgress: v.optional(
      v.object({
        totalToProcess: v.number(),
        processed: v.number(),
        startedAt: v.number(),
        // Set when the final chunk lands. Absent while chunks are still
        // queued. Combined with a 30-min stale check on the client, this is
        // how the dashboard distinguishes "still running" from "abandoned".
        completedAt: v.optional(v.number()),
        // Running totals, incremented by classifyChunk after each chunk so
        // the UI/CLI can read a final summary off this doc once completedAt
        // is set. No need to surface them mid-run.
        classified: v.number(),
        failed: v.number(),
        inputTokens: v.number(),
        outputTokens: v.number(),
        mode: v.union(v.literal("pending"), v.literal("failed")),
      }),
    ),
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
    classificationError: v.optional(v.string()),
    classifiedAt: v.optional(v.number()),
    draftReply: v.union(v.string(), v.null()),
    draftReplyEditedAt: v.optional(v.number()),
    processedAt: v.optional(v.number()),
    status: v.union(
      v.literal("pending"),
      v.literal("processed"),
      v.literal("failed"),
    ),
  })
    .index("by_userId", ["userId"])
    .index("by_userId_classification", ["userId", "classification"]),

  voiceProfiles: defineTable({
    userId: v.id("users"),
    sampleEmails: v.array(v.id("emails")),
    fineTunedAt: v.optional(v.number()),
    lastUpdatedAt: v.number(),
  }).index("by_userId", ["userId"]),
});
