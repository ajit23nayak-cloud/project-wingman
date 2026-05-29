import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { ADMIN_EMAILS } from "./admin";

// Day 6 voice-corpus deepening. voiceSamples is now a per-row table — each
// row is one sent-email snippet dual-tagged with replyType (heuristic,
// inferred at ingest from the snippet text) and segment (LLM-classified
// relationship register). All queries live in the default Convex runtime
// because sentMail.ts is "use node" and node-runtime modules can only export
// actions.

const replyTypeValidator = v.union(
  v.literal("ack"),
  v.literal("decline"),
  v.literal("question"),
  v.literal("propose"),
  v.literal("info"),
);

const segmentValidator = v.union(
  v.literal("cold_outreach"),
  v.literal("internal_team"),
  v.literal("investor_ish"),
  v.literal("casual_peer"),
);

// True iff a sent message with this gmailMessageId is already stored for the
// user. Used by sentMail.ingestSentMailSamples to skip the LLM segment-
// classify call on re-ingest. Indexed lookup, O(1) per check.
export const hasGmailMessageIdInternal = internalQuery({
  args: { userId: v.id("users"), gmailMessageId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db
      .query("voiceSamples")
      .withIndex("by_user_message", (q) =>
        q.eq("userId", args.userId).eq("gmailMessageId", args.gmailMessageId),
      )
      .first();
    return row !== null;
  },
});

export const insertVoiceSampleInternal = internalMutation({
  args: {
    userId: v.id("users"),
    gmailMessageId: v.string(),
    snippet: v.string(),
    subject: v.optional(v.string()),
    replyType: replyTypeValidator,
    segment: segmentValidator,
    segmentConfidence: v.number(),
    sentAt: v.number(),
  },
  handler: async (ctx, args): Promise<Id<"voiceSamples"> | null> => {
    // Re-check dedup at write time. Cheap (indexed) and protects against the
    // ingestion-action racing itself on retry.
    const existing = await ctx.db
      .query("voiceSamples")
      .withIndex("by_user_message", (q) =>
        q.eq("userId", args.userId).eq("gmailMessageId", args.gmailMessageId),
      )
      .first();
    if (existing) return existing._id;

    return await ctx.db.insert("voiceSamples", {
      userId: args.userId,
      gmailMessageId: args.gmailMessageId,
      snippet: args.snippet,
      subject: args.subject,
      replyType: args.replyType,
      segment: args.segment,
      segmentConfidence: args.segmentConfidence,
      sentAt: args.sentAt,
      ingestedAt: Date.now(),
    });
  },
});

export const hasAnyVoiceSamplesInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db
      .query("voiceSamples")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
    return row !== null;
  },
});

// CLI inspection of the corpus state — counts per segment plus total.
// Mirrors what /debug/voice-samples shows, but callable without identity
// so the Day 8+ morning-order CLI flow can verify distribution before
// generating test drafts.
export const countBySegmentInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    cold_outreach: number;
    internal_team: number;
    investor_ish: number;
    casual_peer: number;
    total: number;
  }> => {
    const rows = await ctx.db
      .query("voiceSamples")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    const counts = {
      cold_outreach: 0,
      internal_team: 0,
      investor_ish: 0,
      casual_peer: 0,
      total: rows.length,
    };
    for (const r of rows) counts[r.segment]++;
    return counts;
  },
});

// Drafting-time sample selection. Implements the prioritisation rule:
//   1. samples matching the incoming email's segment
//   2. if 5+ available there, narrow to segment × replyType
//   3. if either bucket has <3, fall back to segment-only top 10
//   4. final fallback: global top 10 by recency
//
// Returns the snippet strings (for the prompt) plus the row ids and the
// segment label actually used — caller stashes the latter two on the email
// doc for the /debug/voice-samples last-10-drafts inspector.
export const listForDraftSelectionInternal = internalQuery({
  args: {
    userId: v.id("users"),
    segment: segmentValidator,
    replyType: replyTypeValidator,
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    snippets: string[];
    snippetIds: Id<"voiceSamples">[];
    segmentUsed:
      | "cold_outreach"
      | "internal_team"
      | "investor_ish"
      | "casual_peer"
      | null;
    selectionPath: "segment_intent" | "segment_only" | "global" | "empty";
  }> => {
    const bySegment = await ctx.db
      .query("voiceSamples")
      .withIndex("by_user_segment", (q) =>
        q.eq("userId", args.userId).eq("segment", args.segment),
      )
      .collect();

    if (bySegment.length >= 5) {
      const intersection = bySegment.filter(
        (r) => r.replyType === args.replyType,
      );
      if (intersection.length >= 3) {
        const top = sortByRecency(intersection).slice(0, 8);
        return {
          snippets: top.map((r) => r.snippet),
          snippetIds: top.map((r) => r._id),
          segmentUsed: args.segment,
          selectionPath: "segment_intent",
        };
      }
    }

    if (bySegment.length >= 3) {
      const top = sortByRecency(bySegment).slice(0, 10);
      return {
        snippets: top.map((r) => r.snippet),
        snippetIds: top.map((r) => r._id),
        segmentUsed: args.segment,
        selectionPath: "segment_only",
      };
    }

    const all = await ctx.db
      .query("voiceSamples")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    if (all.length === 0) {
      return {
        snippets: [],
        snippetIds: [],
        segmentUsed: null,
        selectionPath: "empty",
      };
    }
    const top = sortByRecency(all).slice(0, 10);
    return {
      snippets: top.map((r) => r.snippet),
      snippetIds: top.map((r) => r._id),
      segmentUsed: null,
      selectionPath: "global",
    };
  },
});

function sortByRecency(rows: Doc<"voiceSamples">[]): Doc<"voiceSamples">[] {
  return [...rows].sort((a, b) => b.sentAt - a.sentAt);
}

// Admin-only listing for /debug/voice-samples. Public query — gated by an
// admin-email check at the top, so unauthenticated / non-admin callers get
// an empty array (never throws, never leaks).
export const listAllForAdmin = query({
  args: {},
  handler: async (ctx): Promise<Doc<"voiceSamples">[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) =>
        q.eq("clerkUserId", identity.subject),
      )
      .first();
    if (!user) return [];
    if (!ADMIN_EMAILS.includes(user.email)) return [];
    return await ctx.db
      .query("voiceSamples")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .collect();
  },
});
