// Slack OAuth helpers: token exchange + signed-cookie state nonce for CSRF.
//
// State-nonce design (CSRF protection on the OAuth roundtrip):
//   - /start generates a random nonce, signs it with HMAC-SHA256 keyed on
//     CLERK_SECRET_KEY (no new secret to rotate), and sets `nonce.sig` in
//     an HTTP-only cookie. Only the bare `nonce` goes to Slack as `state=`.
//   - /callback reads the cookie, recomputes the HMAC over the nonce piece,
//     and constant-time-compares against the cookie's sig piece. Then it
//     verifies the query-string state equals the nonce.
//   - This binds the callback to a browser that started the flow (cookie)
//     AND to a state value Slack echoed back (query) — an attacker can't
//     forge either half without CLERK_SECRET_KEY.
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
  scope: string;
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

// generateState: returns the bare nonce (goes to Slack as ?state=) plus the
// signed cookie value (nonce.sig — goes into the HTTP-only cookie). Splitting
// keeps the sig out of the URL/referrer logs.
export function generateState(): { nonce: string; cookieValue: string } {
  const nonce = randomBytes(32).toString("hex");
  const sig = hmacHex(nonce, getSigningKey());
  return { nonce, cookieValue: `${nonce}.${sig}` };
}

// verifyState: returns true ONLY when
//   - the cookie value parses as `nonce.sig`
//   - the cookie's nonce matches the query string's state
//   - the cookie's sig matches a fresh HMAC of the nonce (constant-time)
// Any mismatch / parse failure / length skew returns false (don't throw —
// callers branch on truthy/falsy to pick the right redirect).
export function verifyState(
  stateFromQuery: string,
  cookieValue: string,
): boolean {
  if (!stateFromQuery || !cookieValue) return false;
  const dotIdx = cookieValue.indexOf(".");
  if (dotIdx <= 0 || dotIdx === cookieValue.length - 1) return false;
  const nonce = cookieValue.slice(0, dotIdx);
  const sig = cookieValue.slice(dotIdx + 1);

  // Constant-time nonce compare — `nonce !== stateFromQuery` leaks
  // timing on attacker-supplied state values. Length-check first to
  // satisfy timingSafeEqual's equal-length-buffers requirement.
  const nonceBuf = Buffer.from(nonce);
  const stateBuf = Buffer.from(stateFromQuery);
  if (nonceBuf.length !== stateBuf.length) return false;
  try {
    if (!timingSafeEqual(nonceBuf, stateBuf)) return false;
  } catch {
    return false;
  }

  const expectedSig = hmacHex(nonce, getSigningKey());
  if (sig.length !== expectedSig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
  } catch {
    return false;
  }
}

// exchangeCode: POSTs Slack's oauth.v2.access endpoint to swap the temporary
// `code` from the callback into a long-lived bot token. Slack returns:
//   {
//     ok: true,
//     access_token: "xoxb-...",   // bot token (we store this)
//     token_type: "bot",
//     scope: "im:history,im:read,users:read,team:read",
//     bot_user_id: "U...",
//     team: { id, name },
//     authed_user: { id, ... },   // ignored — we don't request user-token scopes
//     ...
//   }
// We project into SlackOAuthExchangeResult and keep the raw json on `raw`
// for callback-side logging if we need it.
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
    scope: json.scope ?? "",
    raw: json,
  };
}
