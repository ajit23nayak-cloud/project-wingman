import { v } from "convex/values";
import { paginationOptsValidator, PaginationResult } from "convex/server";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
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
  replyStatus: Doc<"emails">["replyStatus"];
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
    replyStatus: e.replyStatus,
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
    const owner = await ctx.runQuery(internal.users.getByIdInternal, {
      userId: email.userId,
    });
    if (!owner) return { error: "owner_not_found" };

    try {
      const { result } = await withTimeout(
        classifyEmailContent({
          fromAddress: email.fromAddress,
          subject: email.subject,
          snippet: email.snippet,
          userEmail: owner.email,
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

// Each chunk fits comfortably in Convex's 600s action ceiling. With the
// 12-RPM defaults (INNER_BATCH=2, GAP_MS=10000), a 50-email chunk takes
// ~325s worst case (25 inner-batches × ~13s).
const CHUNK_SIZE = 50;

// Inner concurrency + post-batch gap are tuned to stay under Gemini free
// tier's 15 RPM cap. Defaults: INNER_BATCH=2 + GAP_MS=10000 → 12 RPM, 20%
// headroom. Both are read fresh on every chunk so `npx convex env set
// CLASSIFY_INNER_BATCH ...` tunes without a redeploy.
//
// Pace math: rpm = (INNER_BATCH * 60_000) / GAP_MS. Re-derive before
// changing values — see feedback_rate_limit_math memory.
function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
function getInnerBatch(): number {
  return readPositiveIntEnv("CLASSIFY_INNER_BATCH", 2);
}
function getGapMs(): number {
  return readPositiveIntEnv("CLASSIFY_GAP_MS", 10_000);
}

export type ClassifyEntrypointResult = {
  mode: "pending" | "failed";
  total: number;
  scheduled: boolean;
  message: string;
};

export const classifyAllPending = action({
  args: {
    mode: v.optional(v.union(v.literal("pending"), v.literal("failed"))),
    // Caps total emails processed in this invocation. Unlimited if absent.
    // Use for sanity-checking after rate-limit recovery, throttling daily
    // burn, or capping cost per click.
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ClassifyEntrypointResult> => {
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
    const cap =
      args.limit !== undefined
        ? Math.min(items.length, args.limit)
        : items.length;
    const emailIds = items.slice(0, cap).map((e) => e._id);
    const total = emailIds.length;

    if (total === 0) {
      return {
        mode,
        total: 0,
        scheduled: false,
        message: `Nothing to classify in mode="${mode}"`,
      };
    }

    const startedAt = Date.now();
    const estimatedCostInr = (total * 0.005).toFixed(2);
    console.log("[classifyAllPending] scheduling", {
      userId: user._id,
      mode,
      total,
      chunkSize: CHUNK_SIZE,
      estimatedCostInr,
    });

    await ctx.runMutation(internal.users.initClassificationProgress, {
      userId: user._id,
      totalToProcess: total,
      startedAt,
      mode,
    });

    // Schedule chunk 0. Each chunk schedules the next, until offset >= total.
    // userEmail rides along so the classifier can apply the self-sent rule
    // without a per-email user lookup.
    await ctx.scheduler.runAfter(0, internal.inbox.classifyChunk, {
      userId: user._id,
      userEmail: user.email,
      emailIds,
      offset: 0,
    });

    return {
      mode,
      total,
      scheduled: true,
      message: `Scheduled ${total} emails in chunks of ${CHUNK_SIZE} (~₹${estimatedCostInr})`,
    };
  },
});

export const classifyChunk = internalAction({
  args: {
    userId: v.id("users"),
    userEmail: v.string(),
    emailIds: v.array(v.id("emails")),
    offset: v.number(),
  },
  handler: async (
    ctx,
    { userId, userEmail, emailIds, offset },
  ): Promise<void> => {
    const slice = emailIds.slice(offset, offset + CHUNK_SIZE);
    const innerBatch = getInnerBatch();
    const gapMs = getGapMs();
    let classified = 0;
    let failed = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    for (let i = 0; i < slice.length; i += innerBatch) {
      const inner = slice.slice(i, i + innerBatch);
      const results = await Promise.all(
        inner.map(async (emailId) => {
          const email = await ctx.runQuery(
            internal.inbox.getEmailByIdInternal,
            { emailId },
          );
          if (!email) return { ok: false as const };
          try {
            const { result, usage } = await withTimeout(
              classifyEmailContent({
                fromAddress: email.fromAddress,
                subject: email.subject,
                snippet: email.snippet,
                userEmail,
              }),
              GEMINI_TIMEOUT_MS,
              `classify ${emailId}`,
            );
            await ctx.runMutation(internal.inbox.applyClassification, {
              emailId,
              classification: result.classification,
              reason: result.reason,
            });
            return { ok: true as const, usage };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[classifyChunk] item failed", { emailId, error: msg });
            await ctx.runMutation(internal.inbox.markClassificationFailed, {
              emailId,
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

      if (i + innerBatch < slice.length) {
        await new Promise((r) => setTimeout(r, gapMs));
      }
    }

    await ctx.runMutation(internal.users.applyChunkResult, {
      userId,
      deltaProcessed: slice.length,
      deltaClassified: classified,
      deltaFailed: failed,
      deltaInputTokens: inputTokens,
      deltaOutputTokens: outputTokens,
    });

    const nextOffset = offset + CHUNK_SIZE;
    if (nextOffset < emailIds.length) {
      await ctx.scheduler.runAfter(0, internal.inbox.classifyChunk, {
        userId,
        userEmail,
        emailIds,
        offset: nextOffset,
      });
    } else {
      await ctx.runMutation(internal.users.markClassificationComplete, {
        userId,
      });
      console.log("[classifyChunk] run complete", {
        userId,
        total: emailIds.length,
      });
    }
  },
});

// Day 4: detail-view fetch. Auth-required, user-scoped — never leak across
// users. The detail view legitimately reads everything in the doc, so we
// return Doc<"emails"> as-is (no slimming).
export const getEmailById = query({
  args: { emailId: v.id("emails") },
  handler: async (ctx, args): Promise<Doc<"emails"> | null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) =>
        q.eq("clerkUserId", identity.subject),
      )
      .first();
    if (!user) return null;
    const email = await ctx.db.get(args.emailId);
    if (!email) return null;
    if (email.userId !== user._id) return null;
    return email;
  },
});

// Day 4 reply lifecycle mutations. Internal — called by draftReply /
// sendReply actions. Public mutations (updateDraftReplyText, skipReply)
// below verify auth + user scope before patching.
export const applyDraftReply = internalMutation({
  args: {
    emailId: v.id("emails"),
    draft: v.string(),
    generatedAt: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.patch(args.emailId, {
      draftReply: args.draft,
      draftReplyGeneratedAt: args.generatedAt,
      replyStatus: "unsent",
    });
  },
});

export const markReplySent = internalMutation({
  args: {
    emailId: v.id("emails"),
    gmailMessageId: v.string(),
    repliedAt: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.patch(args.emailId, {
      replyStatus: "sent",
      replyMessageId: args.gmailMessageId,
      repliedAt: args.repliedAt,
    });
  },
});

export const clearDraftReply = internalMutation({
  args: { emailId: v.id("emails") },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.patch(args.emailId, {
      draftReply: null,
      draftReplyGeneratedAt: undefined,
      draftReplyEditedAt: undefined,
      replyStatus: undefined,
      replyMessageId: undefined,
      repliedAt: undefined,
    });
  },
});

export const updateDraftReplyText = mutation({
  args: { emailId: v.id("emails"), draft: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) =>
        q.eq("clerkUserId", identity.subject),
      )
      .first();
    if (!user) return null;
    const email = await ctx.db.get(args.emailId);
    if (!email || email.userId !== user._id) return null;
    // Refuse to overwrite the historical record of a sent reply.
    if (email.replyStatus === "sent") return null;
    await ctx.db.patch(args.emailId, {
      draftReply: args.draft,
      draftReplyEditedAt: Date.now(),
    });
    return null;
  },
});

export const skipReply = mutation({
  args: { emailId: v.id("emails") },
  handler: async (ctx, args): Promise<null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) =>
        q.eq("clerkUserId", identity.subject),
      )
      .first();
    if (!user) return null;
    const email = await ctx.db.get(args.emailId);
    if (!email || email.userId !== user._id) return null;
    // Already-sent replies are immutable history — skipping is a no-op.
    if (email.replyStatus === "sent") return null;
    await ctx.db.patch(args.emailId, {
      draftReply: null,
      draftReplyGeneratedAt: undefined,
      draftReplyEditedAt: undefined,
      replyStatus: undefined,
      replyMessageId: undefined,
      repliedAt: undefined,
    });
    return null;
  },
});
