import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { classifyEmailContent } from "./prompts/classify";

const classificationFilterValidator = v.union(
  v.literal("all"),
  v.literal("unclassified"),
  v.literal("urgent"),
  v.literal("important"),
  v.literal("fyi"),
  v.literal("archive"),
);

export const listRecent = query({
  args: {
    limit: v.optional(v.number()),
    classification: v.optional(classificationFilterValidator),
  },
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
    const filter = args.classification ?? "all";

    let emails: Doc<"emails">[];
    if (filter === "all") {
      emails = await ctx.db
        .query("emails")
        .withIndex("by_userId", (q) => q.eq("userId", user._id))
        .collect();
    } else if (filter === "unclassified") {
      emails = await ctx.db
        .query("emails")
        .withIndex("by_userId_classification", (q) =>
          q.eq("userId", user._id).eq("classification", null),
        )
        .collect();
    } else {
      emails = await ctx.db
        .query("emails")
        .withIndex("by_userId_classification", (q) =>
          q.eq("userId", user._id).eq("classification", filter),
        )
        .collect();
    }
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

export const getEmailByIdInternal = internalQuery({
  args: { emailId: v.id("emails") },
  handler: async (ctx, args): Promise<Doc<"emails"> | null> => {
    return await ctx.db.get(args.emailId);
  },
});

export const listPendingForUserInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<Doc<"emails">[]> => {
    return await ctx.db
      .query("emails")
      .withIndex("by_userId_classification", (q) =>
        q.eq("userId", args.userId).eq("classification", null),
      )
      .collect();
  },
});

export const applyClassification = internalMutation({
  args: {
    emailId: v.id("emails"),
    classification: v.union(
      v.literal("urgent"),
      v.literal("important"),
      v.literal("fyi"),
      v.literal("archive"),
    ),
    reason: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.patch(args.emailId, {
      classification: args.classification,
      classificationReason: args.reason,
      classifiedAt: Date.now(),
    });
  },
});

type ClassifyResult =
  | { classification: "urgent" | "important" | "fyi" | "archive"; reason: string }
  | { error: string };

export const classifyEmail = action({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }): Promise<ClassifyResult> => {
    const email = await ctx.runQuery(internal.inbox.getEmailByIdInternal, {
      emailId,
    });
    if (!email) return { error: "email_not_found" };

    try {
      const { result } = await classifyEmailContent({
        fromAddress: email.fromAddress,
        subject: email.subject,
        snippet: email.snippet,
      });
      await ctx.runMutation(internal.inbox.applyClassification, {
        emailId,
        classification: result.classification,
        reason: result.reason,
      });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[classifyEmail] failed", { emailId, error: msg });
      return { error: msg };
    }
  },
});

type BatchSummary = {
  total: number;
  classified: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostInr: string;
};

export const classifyAllPending = action({
  args: {},
  handler: async (ctx): Promise<BatchSummary> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const user = await ctx.runQuery(internal.users.getByClerkIdInternal, {
      clerkUserId: identity.subject,
    });
    if (!user) throw new Error("User not found");

    const pending = await ctx.runQuery(
      internal.inbox.listPendingForUserInternal,
      { userId: user._id },
    );
    const total = pending.length;
    const estimatedCostInr = (total * 0.005).toFixed(2);
    const startedAt = Date.now();

    console.log("[classifyAllPending] starting", {
      userId: user._id,
      total,
      estimatedCostInr,
    });

    await ctx.runMutation(internal.users.setClassificationProgress, {
      userId: user._id,
      progress: { totalToProcess: total, processed: 0, startedAt },
    });

    let classified = 0;
    let failed = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    for (let i = 0; i < pending.length; i += 10) {
      const batch = pending.slice(i, i + 10);
      const results = await Promise.allSettled(
        batch.map(async (email) => {
          const { result, usage } = await classifyEmailContent({
            fromAddress: email.fromAddress,
            subject: email.subject,
            snippet: email.snippet,
          });
          await ctx.runMutation(internal.inbox.applyClassification, {
            emailId: email._id,
            classification: result.classification,
            reason: result.reason,
          });
          return usage;
        }),
      );

      for (const r of results) {
        if (r.status === "fulfilled") {
          classified++;
          inputTokens += r.value.inputTokens ?? 0;
          outputTokens += r.value.outputTokens ?? 0;
        } else {
          failed++;
          console.error("[classifyAllPending] item failed", {
            error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          });
        }
      }

      await ctx.runMutation(internal.users.setClassificationProgress, {
        userId: user._id,
        progress: {
          totalToProcess: total,
          processed: classified + failed,
          startedAt,
        },
      });

      if (i + 10 < pending.length) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    await ctx.runMutation(internal.users.setClassificationProgress, {
      userId: user._id,
      progress: null,
    });

    const summary: BatchSummary = {
      total,
      classified,
      failed,
      inputTokens,
      outputTokens,
      estimatedCostInr: `~₹${estimatedCostInr}`,
    };
    console.log("[classifyAllPending] complete", summary);
    return summary;
  },
});
