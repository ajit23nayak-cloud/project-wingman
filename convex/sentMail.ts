"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { listSentMessagesLastNDays } from "./lib/gmail";
import { getGoogleAccessToken } from "./lib/clerkBackend";

const SAMPLE_MAX_CHARS = 200;
const LOOKBACK_DAYS = 30;
const MAX_SAMPLES = 30;

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

async function ingestForUser(
  ctx: { runMutation: any },
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

  let messages: { bodyText: string }[];
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

  const sampleSnippets: string[] = [];
  for (const m of messages) {
    const snippet = toSnippet(m.bodyText ?? "");
    if (snippet.length > 0) sampleSnippets.push(snippet);
  }
  if (messages.length > 0 && sampleSnippets.length === 0) {
    console.warn("[ingestSentMailSamples] all sent messages stripped to empty", {
      clerkUserId,
      candidates: messages.length,
    });
  }

  try {
    await ctx.runMutation(internal.voiceSamples.upsertVoiceSamplesInternal, {
      userId,
      sampleSnippets,
    });
  } catch (err) {
    console.error("[ingestSentMailSamples] upsert failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { count: 0, error: "upsert_failed" };
  }

  return { count: sampleSnippets.length };
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
