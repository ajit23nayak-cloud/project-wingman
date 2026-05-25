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
    draftReplyGeneratedAt: v.optional(v.number()),
    draftReplyEditedAt: v.optional(v.number()),
    // Day 6: voice-corpus draft provenance. Records which relationship segment
    // the incoming email was classified into and which voice-sample rows fed
    // the draft prompt. Powers /debug/voice-samples last-10-drafts panel and
    // future "why did the draft sound like this" debugging. Absent on drafts
    // generated before this feature shipped.
    segmentUsed: v.optional(
      v.union(
        v.literal("cold_outreach"),
        v.literal("internal_team"),
        v.literal("investor_ish"),
        v.literal("casual_peer"),
      ),
    ),
    snippetIndicesUsed: v.optional(v.array(v.id("voiceSamples"))),
    // Day 4: reply lifecycle. Absent = not considered. "unsent" = draft
    // generated, awaiting send. "sent" = delivered via Gmail.
    replyStatus: v.optional(
      v.union(v.literal("unsent"), v.literal("sent")),
    ),
    replyMessageId: v.optional(v.string()),
    repliedAt: v.optional(v.number()),
    processedAt: v.optional(v.number()),
    status: v.union(
      v.literal("pending"),
      v.literal("processed"),
      v.literal("failed"),
    ),
    // Day 7 email-cap: rows aged out of the active window (oldest beyond
    // BACKFILL_EMAIL_CAP or older than STALE_AGE_DAYS) are flagged here so
    // dashboard listing, count, and reclassify queries can exclude them
    // without dropping the data. v.optional so the schema deploys cleanly
    // against existing rows that pre-date this field — queries treat
    // absent as false (active).
    archived_stale: v.optional(v.boolean()),
  })
    .index("by_userId", ["userId"])
    .index("by_userId_classification", ["userId", "classification"]),

  voiceProfiles: defineTable({
    userId: v.id("users"),
    sampleEmails: v.array(v.id("emails")),
    fineTunedAt: v.optional(v.number()),
    lastUpdatedAt: v.number(),
  }).index("by_userId", ["userId"]),

  // Day 6 voice-corpus deepening: per-row table (was a singleton-per-user doc
  // through Day 5). Each row = one sent-email snippet, dual-tagged with
  // replyType (heuristic, free) and segment (LLM-classified relationship
  // register). Drafting prioritises segment match first, then segment×intent
  // intersection when 5+ available, then segment-only, then global.
  //
  // gmailMessageId + by_user_message index → dedup lookup on re-sync so we
  // don't re-classify the same sent email every day.
  voiceSamples: defineTable({
    userId: v.id("users"),
    gmailMessageId: v.string(),
    snippet: v.string(),
    subject: v.optional(v.string()),
    replyType: v.union(
      v.literal("ack"),
      v.literal("decline"),
      v.literal("question"),
      v.literal("propose"),
      v.literal("info"),
    ),
    segment: v.union(
      v.literal("cold_outreach"),
      v.literal("internal_team"),
      v.literal("investor_ish"),
      v.literal("casual_peer"),
    ),
    segmentConfidence: v.number(),
    sentAt: v.number(),
    ingestedAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_user_message", ["userId", "gmailMessageId"])
    .index("by_user_segment", ["userId", "segment"]),
});
