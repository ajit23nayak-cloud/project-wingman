"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { listSentMessagesLastNDays, SentMessage } from "./lib/gmail";
import { getGoogleAccessToken } from "./lib/clerkBackend";
import { classifySegmentContent, Segment } from "./prompts/classifySegment";
import { classifyReplyType } from "./lib/replyType";

const SAMPLE_MAX_CHARS = 200;
// Day 6 voice-corpus deepening: widen window to 90 days × 100 messages so the
// per-segment buckets fill enough for segment×replyType selection to fire
// instead of falling back to global.
const LOOKBACK_DAYS = 90;
const MAX_SAMPLES = 100;

const GEMINI_TIMEOUT_MS = 30_000;

// Pace math: rpm = (INNER_BATCH * 60_000) / GAP_MS = (2 * 60_000) / 10_000 = 12
// Matches the inbox classifier's 12 RPM (20% headroom under Gemini free-tier
// 15 RPM cap). Re-derive before changing — see feedback_rate_limit_math memory.
function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
function getInnerBatch(): number {
  return readPositiveIntEnv("VOICE_INNER_BATCH", 2);
}
function getGapMs(): number {
  return readPositiveIntEnv("VOICE_GAP_MS", 10_000);
}

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

// Strip quoted history from a sent-mail body so the snippet captures only what
// the user actually wrote. Two passes:
//  1. Cut everything from the first "On <...> wrote:" attribution line onward
//     (Gmail's standard reply prefix), with or without a leading blank line.
//  2. Strip any remaining lines that begin with ">" (legacy quote markers).
function stripQuotedHistory(raw: string): string {
  let body = raw;
  const attribution = /(^|\n)\s*On [\s\S]+? wrote:\s*\n?/;
  const match = body.match(attribution);
  if (match && match.index !== undefined) {
    body = body.slice(0, match.index);
  }
  body = body
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
  return body.trim();
}

function toSnippet(bodyText: string): string {
  const stripped = stripQuotedHistory(bodyText);
  return stripped.slice(0, SAMPLE_MAX_CHARS).trim();
}

type PerMessageOutcome =
  | { kind: "inserted"; segment: Segment }
  | { kind: "skippedDedup" }
  | { kind: "skippedEmpty" }
  | { kind: "classifyFailed" };

async function ingestForUser(
  ctx: { runMutation: any; runQuery: any },
  userId: Id<"users">,
  clerkUserId: string,
): Promise<{ count: number; error?: string }> {
  let token: string | null;
  try {
    token = await getGoogleAccessToken(clerkUserId);
  } catch (err) {
    console.error("[ingestSentMailSamples] Clerk token fetch failed", {
      clerkUserId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { count: 0, error: "token_fetch_failed" };
  }
  if (!token) {
    return { count: 0, error: "no_google_token" };
  }

  let messages: SentMessage[];
  try {
    messages = await listSentMessagesLastNDays(
      token,
      LOOKBACK_DAYS,
      MAX_SAMPLES,
    );
  } catch (err) {
    console.error("[ingestSentMailSamples] Gmail sent-list failed", {
      clerkUserId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { count: 0, error: "gmail_fetch_failed" };
  }

  const innerBatch = getInnerBatch();
  const gapMs = getGapMs();

  let inserted = 0;
  let skippedDedup = 0;
  let skippedEmpty = 0;
  let classifyFailed = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const segmentCounts: Record<Segment, number> = {
    cold_outreach: 0,
    internal_team: 0,
    investor_ish: 0,
    casual_peer: 0,
  };

  for (let i = 0; i < messages.length; i += innerBatch) {
    const inner = messages.slice(i, i + innerBatch);
    const outcomes: PerMessageOutcome[] = await Promise.all(
      inner.map(async (m): Promise<PerMessageOutcome> => {
        // Dedup BEFORE the LLM call — re-ingest of an already-stored message
        // should never burn a Gemini quota credit.
        const already = await ctx.runQuery(
          internal.voiceSamples.hasGmailMessageIdInternal,
          { userId, gmailMessageId: m.messageId },
        );
        if (already) return { kind: "skippedDedup" };

        const snippet = toSnippet(m.bodyText ?? "");
        if (snippet.length === 0) return { kind: "skippedEmpty" };

        const replyType = classifyReplyType(snippet);

        let segment: Segment;
        let segmentConfidence: number;
        let usageIn = 0;
        let usageOut = 0;
        try {
          const { result, usage } = await withTimeout(
            classifySegmentContent({
              subject: m.subject,
              bodyText: snippet,
            }),
            GEMINI_TIMEOUT_MS,
            `classifySegment ${m.messageId}`,
          );
          segment = result.segment;
          segmentConfidence = result.confidence;
          usageIn = usage.inputTokens ?? 0;
          usageOut = usage.outputTokens ?? 0;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[ingestSentMailSamples] segment classify failed", {
            gmailMessageId: m.messageId,
            error: msg,
          });
          // Leave for retry on next sync — don't insert a row with a guessed
          // segment, that would poison the corpus.
          return { kind: "classifyFailed" };
        }

        try {
          await ctx.runMutation(
            internal.voiceSamples.insertVoiceSampleInternal,
            {
              userId,
              gmailMessageId: m.messageId,
              snippet,
              subject: m.subject,
              replyType,
              segment,
              segmentConfidence,
              sentAt: m.sentAt,
            },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[ingestSentMailSamples] insert failed", {
            gmailMessageId: m.messageId,
            error: msg,
          });
          return { kind: "classifyFailed" };
        }

        // Stash usage on the outcome so the outer loop can aggregate without
        // a second pass. Cheap closure capture instead.
        inputTokens += usageIn;
        outputTokens += usageOut;
        return { kind: "inserted", segment };
      }),
    );

    for (const o of outcomes) {
      switch (o.kind) {
        case "inserted":
          inserted++;
          segmentCounts[o.segment]++;
          break;
        case "skippedDedup":
          skippedDedup++;
          break;
        case "skippedEmpty":
          skippedEmpty++;
          break;
        case "classifyFailed":
          classifyFailed++;
          break;
      }
    }

    if (i + innerBatch < messages.length) {
      await new Promise((r) => setTimeout(r, gapMs));
    }
  }

  if (messages.length > 0 && inserted === 0 && skippedDedup === 0) {
    console.warn("[ingestSentMailSamples] all sent messages stripped to empty", {
      clerkUserId,
      candidates: messages.length,
    });
  }

  console.log("[ingestSentMailSamples] done", {
    clerkUserId,
    candidates: messages.length,
    inserted,
    skippedDedup,
    skippedEmpty,
    classifyFailed,
    bySegment: segmentCounts,
    tokens: { input: inputTokens, output: outputTokens },
  });

  return { count: inserted };
}

export const ingestSentMailSamples = action({
  args: {},
  handler: async (ctx): Promise<{ count: number; error?: string }> => {
    const identity = await ctx.auth.getUserIdentity();

    let userId: Id<"users">;
    let clerkUserId: string;

    if (identity) {
      clerkUserId = identity.subject;
      const user = await ctx.runQuery(internal.users.getByClerkIdInternal, {
        clerkUserId,
      });
      if (!user) {
        return { count: 0, error: "user_not_found" };
      }
      userId = user._id;
    } else {
      // CLI / admin run (single-user beta): pick the only user. Mirrors the
      // fallback in inbox.classifyAllPending — tighten when user count > 1.
      const all = await ctx.runQuery(internal.users.listAllInternal, {});
      if (all.length !== 1) {
        return {
          count: 0,
          error: `not_authenticated_and_cli_fallback_requires_1_user (found ${all.length})`,
        };
      }
      userId = all[0]._id;
      clerkUserId = all[0].clerkUserId;
    }

    return await ingestForUser(ctx, userId, clerkUserId);
  },
});

// Called by the scheduler from emails.ingestEmails; the caller already knows
// both userId and clerkUserId, so we take both directly to avoid a follow-up
// query (and so this stays an action-only "use node" module).
export const ingestSentMailSamplesInternal = internalAction({
  args: { userId: v.id("users"), clerkUserId: v.string() },
  handler: async (
    ctx,
    { userId, clerkUserId },
  ): Promise<{ count: number; error?: string }> => {
    return await ingestForUser(ctx, userId, clerkUserId);
  },
});
