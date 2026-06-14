// Slack OAuth helpers: token exchange + HMAC-signed state for CSRF.
//
// State design (CSRF protection on the OAuth roundtrip):
//   - /start generates a random nonce, signs HMAC-SHA256 over
//     `${clerkUserId}.${nonce}` keyed on CLERK_SECRET_KEY, and sends
//     `${nonce}.${sig}` to Slack as the `state=` query param.
//   - /callback re-fetches the clerkUserId from the current session,
//     parses state on the `.` separator, recomputes the HMAC over
//     `${clerkUserId}.${nonce}`, and constant-time-compares the sigs.
//   - Binding state to clerkUserId means a captured state value can't be
//     replayed in a different account — the sig won't match the attacker's
//     clerkUserId. Attacker can't forge new states without CLERK_SECRET_KEY.
//
// Why cookieless: the previous cookie-bound design (cookie holds sig, URL
// holds nonce) broke under Vercel's multi-hostname deploys. A user might
// hit /start on a preview-deployment hostname, get the cookie set there,
// then have Slack redirect them back to the production hostname where the
// cookie isn't in the browser's jar for that origin. URL-only state with
// HMAC verification is hostname-independent and works across any deploy
// URL the redirect chain happens to traverse.
//
// Trade-off (vs cookie): state appears in URL/referrer logs. The HMAC
// binding to clerkUserId mitigates: a leaked state for user A can't be
// replayed by user B. v1 hardening would add a short-TTL consumed-states
// table to also prevent replay within the same user account.
//
// Why CLERK_SECRET_KEY as the HMAC key: it's already a per-environment
// secret guaranteed to exist on every route (Clerk auth depends on it),
// so we get a free signing key without adding another env var to rotate.

import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type SlackOAuthExchangeResult = {
  ok: boolean;
  team: { id: string; name: string };
  bot: { token: string; user_id: string };
  // Slack v2 OAuth optionally returns authed_user.access_token when the
  // start URL includes user_scope=. Wingman's ingest path needs this — bot
  // tokens can't read the user's 1:1 DMs with other humans, only DMs where
  // the bot is a participant. user_token may be null on legacy installs
  // (workspaces connected before the user-scope fix landed); the ingest
  // cron treats null as "needs reconnect" and skips.
  userToken: string | null;
  scope: string;
  userScope: string;
  raw: unknown;
};

// siteOrigin: prefer NEXT_PUBLIC_SITE_URL (set in Vercel) so the redirect_uri
// matches what's registered in the Slack app config. VERCEL_URL is the
// per-deployment URL — only useful in preview branches if NEXT_PUBLIC_SITE_URL
// isn't set. localhost is the dev fallback (Slack OAuth doesn't actually
// allow localhost redirects, but the type signature stays uniform).
export function siteOrigin(): string {
  // Trim trailing slash — Slack's redirect_uri match is exact, so
  // NEXT_PUBLIC_SITE_URL="https://app.example.com/" must not turn into
  // "https://app.example.com//api/slack/oauth/callback".
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

function getSigningKey(): string {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) {
    throw new Error("CLERK_SECRET_KEY is not set (needed for state-nonce HMAC)");
  }
  return key;
}

function hmacHex(value: string, key: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

// generateState: returns a single `nonce.sig` string to send to Slack as
// `?state=...`. The sig binds the nonce to the Clerk user so a leaked state
// can't be replayed by a different account (the callback recomputes the sig
// using the recipient's clerkUserId; mismatch = reject).
export function generateState(clerkUserId: string): string {
  const nonce = randomBytes(32).toString("hex");
  const sig = hmacHex(`${clerkUserId}.${nonce}`, getSigningKey());
  return `${nonce}.${sig}`;
}

// verifyState: returns true ONLY when
//   - the state value parses as `nonce.sig`
//   - the sig is a valid HMAC of `${clerkUserId}.${nonce}` with our key
// Any mismatch / parse failure / length skew returns false (don't throw —
// callers branch on truthy/falsy to pick the right redirect).
export function verifyState(
  stateFromQuery: string,
  clerkUserId: string,
): boolean {
  if (!stateFromQuery || !clerkUserId) return false;
  const dotIdx = stateFromQuery.indexOf(".");
  if (dotIdx <= 0 || dotIdx === stateFromQuery.length - 1) return false;
  const nonce = stateFromQuery.slice(0, dotIdx);
  const sig = stateFromQuery.slice(dotIdx + 1);

  const expectedSig = hmacHex(`${clerkUserId}.${nonce}`, getSigningKey());
  // timingSafeEqual requires equal-length buffers — guard before calling.
  if (sig.length !== expectedSig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
  } catch {
    return false;
  }
}

// exchangeCode: POSTs Slack's oauth.v2.access endpoint to swap the temporary
// `code` for the install's long-lived tokens. With user_scope= on the start
// URL, Slack returns BOTH a bot token (top-level access_token, xoxb-...) AND
// a user token (authed_user.access_token, xoxp-...):
//   {
//     ok: true,
//     access_token: "xoxb-...",   // bot token
//     token_type: "bot",
//     scope: "im:history,im:read,users:read,team:read",
//     bot_user_id: "U...",
//     team: { id, name },
//     authed_user: {
//       id: "U...",
//       scope: "im:history,im:read,users:read",
//       access_token: "xoxp-..."  // user token — ingest cron uses this
//     },
//     ...
//   }
// Wingman's ingest path uses the USER token to read the user's 1:1 DMs.
// Bot token is kept for any future bot-specific API surface (status,
// presence pings, etc.). Both flow into slack_credentials.
export async function exchangeCode(
  code: string,
): Promise<SlackOAuthExchangeResult> {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "SLACK_CLIENT_ID / SLACK_CLIENT_SECRET not set — cannot exchange OAuth code",
    );
  }

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: `${siteOrigin()}/api/slack/oauth/callback`,
  });

  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    body,
  });
  const json = (await res.json()) as {
    ok: boolean;
    error?: string;
    access_token?: string;
    bot_user_id?: string;
    scope?: string;
    team?: { id?: string; name?: string };
    authed_user?: {
      id?: string;
      scope?: string;
      access_token?: string;
    };
  };

  if (!json.ok) {
    throw new Error(
      `slack_oauth_exchange_failed:${json.error ?? "unknown"}`,
    );
  }
  if (!json.access_token || !json.bot_user_id || !json.team?.id) {
    throw new Error("slack_oauth_exchange_missing_fields");
  }

  return {
    ok: true,
    team: {
      id: json.team.id,
      name: json.team.name ?? "",
    },
    bot: {
      token: json.access_token,
      user_id: json.bot_user_id,
    },
    // null when the Slack manifest doesn't grant any user scopes — we log
    // and the ingest cron treats this workspace as "needs reconnect."
    userToken: json.authed_user?.access_token ?? null,
    scope: json.scope ?? "",
    userScope: json.authed_user?.scope ?? "",
    raw: json,
  };
}
