// Thin Slack Web API wrappers. We don't use @slack/web-api because
//   (a) one fewer dep,
//   (b) we only use 3 methods (conversations.list, conversations.history,
//       users.info — plus the oauth.v2.access exchange in oauth.ts),
//   (c) error-handling needs a SlackAuthError typed exception that the SDK
//       doesn't expose cleanly. Routes catch SlackAuthError specifically and
//       mark the workspace disconnected — without a typed error, the catch
//       would have to inspect every Error subclass to know whether the
//       failure is "user needs to reconnect" vs. "transient API hiccup."
//
// Mirrors the GmailAuthError pattern from src/lib/gmail.ts.

import "server-only";

// Typed sentinel for Slack auth failures. Slack returns these error codes
// at the JSON-body level (HTTP is usually 200 — quirky API), so we have to
// inspect `ok: false` + `error` field rather than HTTP status.
//
// invalid_auth / not_authed     → token doesn't look valid
// token_revoked                 → user revoked the app or rotated workspace tokens
// account_inactive              → workspace deactivated
//
// All four are unrecoverable without user action (reconnect Slack).
export class SlackAuthError extends Error {
  constructor(public readonly slackError: string) {
    super(`slack_auth_failed:${slackError}`);
    this.name = "SlackAuthError";
  }
}

const AUTH_ERROR_CODES = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "account_inactive",
]);

export type SlackMessage = {
  ts: string;
  user: string;
  text: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
};

type SlackApiResponse = {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
  [k: string]: unknown;
};

// Single point where we turn { ok: false } into either SlackAuthError or
// a generic slack_api_failed Error. Keep this surface narrow so callers
// always know which one to expect.
function throwOnSlackError(method: string, json: SlackApiResponse): void {
  if (json.ok) return;
  const err = json.error ?? "unknown";
  if (AUTH_ERROR_CODES.has(err)) {
    throw new SlackAuthError(err);
  }
  throw new Error(`slack_api_failed:${method}:${err}`);
}

// Form-encoded POST. Slack accepts both JSON and form bodies; form is
// simpler for single-param methods (users.info) and matches their docs.
async function postForm(
  method: string,
  botToken: string,
  params: Record<string, string>,
): Promise<SlackApiResponse> {
  const body = new URLSearchParams(params);
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    body,
  });
  const json = (await res.json()) as SlackApiResponse;
  throwOnSlackError(method, json);
  return json;
}

// JSON POST. Used when the request body has nested or numeric fields where
// form-encoding is less ergonomic (conversations.history with oldest as a
// stringified epoch is fine either way, but JSON keeps types explicit).
async function postJson(
  method: string,
  botToken: string,
  body: Record<string, unknown>,
): Promise<SlackApiResponse> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as SlackApiResponse;
  throwOnSlackError(method, json);
  return json;
}

// List the bot's DM channels (types=im). One DM channel per user the bot
// has a conversation with. Paginates if Slack returns response_metadata.
// next_cursor — rare at limit=200 unless a workspace has 200+ DMs with the
// bot.
export async function listImChannels(
  botToken: string,
): Promise<{ id: string; user: string }[]> {
  const out: { id: string; user: string }[] = [];
  let cursor: string | undefined;
  do {
    const params: Record<string, string> = {
      types: "im",
      limit: "200",
    };
    if (cursor) params.cursor = cursor;
    const json = await postForm("conversations.list", botToken, params);
    const channels = (json.channels ?? []) as Array<{
      id?: string;
      user?: string;
    }>;
    for (const c of channels) {
      if (c.id && c.user) out.push({ id: c.id, user: c.user });
    }
    cursor = json.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return out;
}

// Fetch a single page of conversation history for a channel since `oldestSec`
// (unix epoch seconds — Slack's `oldest` param is a string). Caller paginates
// by re-invoking with the returned nextCursor until it's undefined/empty.
//
// limit=200 is Slack's per-page cap for non-marketplace apps; matches their
// recommended polling pattern.
export async function fetchConversationHistory(
  botToken: string,
  channelId: string,
  oldestSec: number,
  cursor?: string,
): Promise<{ messages: SlackMessage[]; nextCursor?: string }> {
  const body: Record<string, unknown> = {
    channel: channelId,
    oldest: String(oldestSec),
    limit: 200,
  };
  if (cursor) body.cursor = cursor;
  const json = await postJson("conversations.history", botToken, body);
  const raw = (json.messages ?? []) as Array<Partial<SlackMessage>>;
  const messages: SlackMessage[] = [];
  for (const m of raw) {
    if (typeof m.ts !== "string" || typeof m.user !== "string") continue;
    messages.push({
      ts: m.ts,
      user: m.user,
      text: typeof m.text === "string" ? m.text : "",
      thread_ts: m.thread_ts,
      subtype: m.subtype,
      bot_id: m.bot_id,
    });
  }
  const nextCursor = json.response_metadata?.next_cursor || undefined;
  return { messages, nextCursor };
}

// Slack has no batch endpoint for users.info — one HTTP call per user id.
// We parallelize via Promise.allSettled so a single failed lookup (deleted
// user, restricted profile) doesn't drop the whole map.
//
// Auth-failure detection is subtle: if the bot token itself is bad, EVERY
// call will throw SlackAuthError. We surface the FIRST SlackAuthError we
// see so the caller can disconnect the workspace; per-user errors (404,
// "user_not_found") are silently skipped.
export async function usersInfo(
  botToken: string,
  userIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (userIds.length === 0) return out;

  // Deduplicate — DMs often share the same counterparty across messages.
  const uniqueIds = Array.from(new Set(userIds));

  const results = await Promise.allSettled(
    uniqueIds.map(async (userId) => {
      const json = await postForm("users.info", botToken, { user: userId });
      const user = json.user as
        | { real_name?: string; name?: string }
        | undefined;
      const displayName = user?.real_name || user?.name || "";
      return { userId, displayName };
    }),
  );

  for (const r of results) {
    if (r.status === "fulfilled") {
      if (r.value.displayName) {
        out.set(r.value.userId, r.value.displayName);
      }
      continue;
    }
    // Bubble the first auth error — token is bad, all the rest will fail
    // identically, no point continuing.
    if (r.reason instanceof SlackAuthError) {
      throw r.reason;
    }
    // Per-user failure (user_not_found, missing_scope on this specific
    // user's profile, etc.) — skip, partial map is fine.
  }
  return out;
}
