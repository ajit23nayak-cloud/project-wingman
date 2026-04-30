import { v } from "convex/values";
import { paginationOptsValidator, PaginationResult } from "convex/server";
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

export type EmailListItem = {
  _id: Id<"emails">;
  fromAddress: string;
  subject: string;
  snippet: string;
  classification: Doc<"emails">["classification"];
  classificationReason: string | undefined;
  receivedAt: number;
};

const SNIPPET_MAX = 200;

function toListItem(e: Doc<"emails">): EmailListItem {
  return {
    _id: e._id,
    fromAddress: e.fromAddress,
    subject: e.subject,
    snippet: (e.snippet ?? "").slice(0, SNIPPET_MAX),
    classification: e.classification,
    classificationReason: e.classificationReason,
    receivedAt: e.receivedAt,
  };
}

export const listPaginated = query({
  args: {
    paginationOpts: paginationOptsValidator,
    classification: v.optional(classificationFilterValidator),
  },
  handler: async (ctx, args): Promise<PaginationResult<EmailListItem>> => {
    const empty: PaginationResult<EmailListItem> = {
      page: [],
      isDone: true,
      continueCursor: "",
    };
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return empty;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) =>
        q.eq("clerkUserId", identity.subject),
      )
      .first();
    if (!user) return empty;

    const filter = args.classification ?? "all";
    const queryBuilder =
      filter === "all"
        ? ctx.db
            .query("emails")
            .withIndex("by_userId", (q) => q.eq("userId", user._id))
        : filter === "unclassified"
          ? ctx.db
              .query("emails")
              .withIndex("by_userId_classification", (q) =>
                q.eq("userId", user._id).eq("classification", null),
              )
          : ctx.db
              .query("emails")
              .withIndex("by_userId_classification", (q) =>
                q.eq("userId", user._id).eq("classification", filter),
              );

    const result = await queryBuilder.order("desc").paginate(args.paginationOpts);
    return { ...result, page: result.page.map(toListItem) };
  },
});

export type ClassificationCounts = {
  total: number;
  unclassified: number;
  failed: number;
  urgent: number;
  important: number;
  fyi: number;
  archive: number;
};

export const getClassificationCounts = query({
  args: {},
  handler: async (ctx): Promise<ClassificationCounts> => {
    const empty: ClassificationCounts = {
      total: 0,
      unclassified: 0,
      failed: 0,
      urgent: 0,
      important: 0,
      fyi: 0,
      archive: 0,
    };
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return empty;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) =>
        q.eq("clerkUserId", identity.subject),
      )
      .first();
    if (!user) return empty;
    const emails = await ctx.db
      .query("emails")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .collect();
    const counts = { ...empty, total: emails.length };
    for (const e of emails) {
      if (e.classification === null) {
        counts.unclassified++;
      } else {
        counts[e.classification]++;
      }
      if (e.classificationError !== undefined) counts.failed++;
    }
    return counts;
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
    const nulls = await ctx.db
      .query("emails")
      .withIndex("by_userId_classification", (q) =>
        q.eq("userId", args.userId).eq("classification", null),
      )
      .collect();
    return nulls.filter((e) => e.classificationError === undefined);
  },
});

export const listFailedForUserInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<Doc<"emails">[]> => {
    const all = await ctx.db
      .query("emails")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    return all.filter((e) => e.classificationError !== undefined);
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
      classificationError: undefined,
    });
  },
});

export const markClassificationFailed = internalMutation({
  args: { emailId: v.id("emails"), error: v.string() },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.patch(args.emailId, { classificationError: args.error });
  },
});

type ClassifyResult =
  | { classification: "urgent" | "important" | "fyi" | "archive"; reason: string }
  | { error: string };

const GEMINI_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`timeout after ${ms}ms (${label})`)),
        ms,
      ),
    ),
  ]);
}

export const classifyEmail = action({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }): Promise<ClassifyResult> => {
    const email = await ctx.runQuery(internal.inbox.getEmailByIdInternal, {
      emailId,
    });
    if (!email) return { error: "email_not_found" };

    try {
      const { result } = await withTimeout(
        classifyEmailContent({
          fromAddress: email.fromAddress,
          subject: email.subject,
          snippet: email.snippet,
        }),
        GEMINI_TIMEOUT_MS,
        `classifyEmail ${emailId}`,
      );
      await ctx.runMutation(internal.inbox.applyClassification, {
        emailId,
        classification: result.classification,
        reason: result.reason,
      });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[classifyEmail] failed", { emailId, error: msg });
      await ctx.runMutation(internal.inbox.markClassificationFailed, {
        emailId,
        error: msg,
      });
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
  args: {
    mode: v.optional(v.union(v.literal("pending"), v.literal("failed"))),
  },
  handler: async (ctx, args): Promise<BatchSummary> => {
    const mode = args.mode ?? "pending";
    const identity = await ctx.auth.getUserIdentity();
    let user;
    if (identity) {
      user = await ctx.runQuery(internal.users.getByClerkIdInternal, {
        clerkUserId: identity.subject,
      });
      if (!user) throw new Error("User not found");
    } else {
      // CLI / admin run (single-user beta): pick the only user.
      const all = await ctx.runQuery(internal.users.listAllInternal, {});
      if (all.length !== 1) {
        throw new Error(
          `Not authenticated and CLI fallback requires exactly 1 user (found ${all.length})`,
        );
      }
      user = all[0];
    }

    const items =
      mode === "pending"
        ? await ctx.runQuery(internal.inbox.listPendingForUserInternal, {
            userId: user._id,
          })
        : await ctx.runQuery(internal.inbox.listFailedForUserInternal, {
            userId: user._id,
          });
    const total = items.length;
    const estimatedCostInr = (total * 0.005).toFixed(2);
    const startedAt = Date.now();

    console.log("[classifyAllPending] starting", {
      userId: user._id,
      mode,
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

    for (let i = 0; i < items.length; i += 10) {
      const batch = items.slice(i, i + 10);
      const results = await Promise.all(
        batch.map(async (email) => {
          try {
            const { result, usage } = await withTimeout(
              classifyEmailContent({
                fromAddress: email.fromAddress,
                subject: email.subject,
                snippet: email.snippet,
              }),
              GEMINI_TIMEOUT_MS,
              `classify ${email._id}`,
            );
            await ctx.runMutation(internal.inbox.applyClassification, {
              emailId: email._id,
              classification: result.classification,
              reason: result.reason,
            });
            return { ok: true as const, usage };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[classifyAllPending] item failed", {
              emailId: email._id,
              error: msg,
            });
            await ctx.runMutation(internal.inbox.markClassificationFailed, {
              emailId: email._id,
              error: msg,
            });
            return { ok: false as const };
          }
        }),
      );

      for (const r of results) {
        if (r.ok) {
          classified++;
          inputTokens += r.usage.inputTokens ?? 0;
          outputTokens += r.usage.outputTokens ?? 0;
        } else {
          failed++;
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

      if (i + 10 < items.length) {
        await new Promise((r) => setTimeout(r, 200));
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
