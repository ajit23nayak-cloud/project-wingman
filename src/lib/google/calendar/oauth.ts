// Google Calendar OAuth helpers: token exchange + refresh + HMAC-signed
// state for CSRF.
//
// Mirrors src/lib/slack/oauth.ts and src/lib/notion/oauth.ts. State mechanism
// is intentionally duplicated (not shared via a common helper) so a future
// calendar-specific hardening doesn't blast-radius into Slack / Notion.
//
// State design (CSRF protection on the OAuth roundtrip):
//   - /start generates a random nonce, signs HMAC-SHA256 over
//     `${clerkUserId}.${nonce}` keyed on CLERK_SECRET_KEY, and sends
//     `${nonce}.${sig}` to Google as the `state=` query param.
//   - /callback re-fetches clerkUserId from the current session, parses
//     state on the `.` separator, recomputes the HMAC over
//     `${clerkUserId}.${nonce}`, and constant-time-compares the sigs.
//   - Binding state to clerkUserId means a captured state can't be replayed
//     in a different account.
//
// Why cookieless: Vercel multi-hostname (preview vs prod) cookies don't
// travel — same issue Slack/Notion hit.
//
// REFRESH TOKEN FLOW (load-bearing):
//   Google omits refresh_token from the initial exchange response UNLESS the
//   auth URL has BOTH access_type=offline AND prompt=consent. Without these,
//   we'd silently re-auth-fail after the first hour when the access token
//   expires and we have no refresh path. exchangeCode() THROWS if Google
//   doesn't return a refresh_token, so a missing access_type=offline in the
//   start URL surfaces immediately, not at hour 1.
//
//   On the refresh path (grant_type=refresh_token), Google does NOT return
//   a new refresh_token — that's normal. refreshAccessToken returns
//   refreshToken: null on success; caller COALESCEs to preserve the existing
//   refresh_token in the DB.

import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { GoogleCalendarAuthError } from "./client";

export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
];

export type GoogleCalendarOAuthExchange = {
  ok: boolean;
  accessToken: string;
  // Initial exchange returns refresh_token (when access_type=offline +
  // prompt=consent). exchangeCode throws if missing, so this is always set
  // on a successful return.
  refreshToken: string;
  expiresAt: Date;
  scope: string;
};

export type GoogleCalendarTokenRefresh = {
  accessToken: string;
  expiresAt: Date;
  // Refresh flow normally returns NO new refresh_token — Google reuses the
  // existing one. Caller COALESCEs at the DB level rather than overwriting
  // with null. Set to non-null only if Google rotated the refresh token
  // (rare, but possible when scopes change).
  refreshToken: string | null;
};

// siteOrigin: mirror Slack/Notion. Trim trailing slash because Google's
// redirect_uri match is exact.
export function siteOrigin(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

function getSigningKey(): string {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) {
    throw new Error(
      "CLERK_SECRET_KEY is not set (needed for state-nonce HMAC)",
    );
  }
  return key;
}

function hmacHex(value: string, key: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

// generateState: returns `nonce.sig` to send to Google as ?state=. The sig
// binds the nonce to the Clerk user so a leaked state can't be replayed by
// another account.
export function generateState(clerkUserId: string): string {
  const nonce = randomBytes(32).toString("hex");
  const sig = hmacHex(`${clerkUserId}.${nonce}`, getSigningKey());
  return `${nonce}.${sig}`;
}

// verifyState: true ONLY when the state parses as `nonce.sig` and the sig
// is a valid HMAC of `${clerkUserId}.${nonce}` with our key. Any parse
// failure, length mismatch, or sig mismatch returns false.
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
  if (sig.length !== expectedSig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
  } catch {
    return false;
  }
}

function getOAuthCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET not set — cannot run Google OAuth",
    );
  }
  return { clientId, clientSecret };
}

// exchangeCode: POSTs Google's /token endpoint with grant_type=authorization_code
// to swap the temporary code for { access_token, refresh_token, expires_in,
// scope, token_type }.
//
// CRITICAL: throws if response is missing refresh_token. That can only happen
// if the start URL forgot access_type=offline + prompt=consent — surface it
// immediately rather than letting the first refresh-after-expiry fail an hour
// later with a cryptic error.
export async function exchangeCode(
  code: string,
): Promise<GoogleCalendarOAuthExchange> {
  const { clientId, clientSecret } = getOAuthCredentials();

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: `${siteOrigin()}/api/google/calendar/oauth/callback`,
    grant_type: "authorization_code",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    body,
  });

  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };

  if (!res.ok) {
    throw new Error(
      `google_calendar_oauth_exchange_failed:${json.error ?? res.status}`,
    );
  }
  if (!json.access_token || !json.refresh_token || !json.expires_in) {
    // Missing refresh_token = start URL almost certainly forgot
    // access_type=offline or prompt=consent. Don't pretend it succeeded.
    throw new Error(
      `google_calendar_oauth_exchange_missing_fields:access_token=${!!json.access_token}:refresh_token=${!!json.refresh_token}:expires_in=${!!json.expires_in}`,
    );
  }

  const expiresAt = new Date(Date.now() + json.expires_in * 1000);

  return {
    ok: true,
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt,
    scope: json.scope ?? CALENDAR_SCOPES.join(" "),
  };
}

// refreshAccessToken: POSTs same /token endpoint with grant_type=refresh_token.
// Response shape: { access_token, expires_in, scope, token_type } —
// Google does NOT return a new refresh_token in this response, that's normal.
// Returns refreshToken: null on the typical case; caller COALESCEs.
//
// 4xx on refresh ALMOST ALWAYS means the user revoked access (or rotated
// their password, or the token was unused for 6+ months). Throw
// GoogleCalendarAuthError so the cron can mark status='disconnected' and
// surface a reconnect CTA.
export async function refreshAccessToken(
  refreshToken: string,
): Promise<GoogleCalendarTokenRefresh> {
  const { clientId, clientSecret } = getOAuthCredentials();

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    body,
  });

  if (res.status >= 400 && res.status < 500) {
    // 400/401 here = invalid_grant (revoked / expired). Force reconnect.
    throw new GoogleCalendarAuthError(res.status);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `google_calendar_oauth_refresh_failed:${res.status}:${detail.slice(0, 200)}`,
    );
  }

  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string; // usually absent
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };

  if (!json.access_token || !json.expires_in) {
    throw new Error("google_calendar_oauth_refresh_missing_fields");
  }

  const expiresAt = new Date(Date.now() + json.expires_in * 1000);

  return {
    accessToken: json.access_token,
    expiresAt,
    // Null on the typical case — Google omits refresh_token from refresh
    // responses. Caller COALESCEs.
    refreshToken: json.refresh_token ?? null,
  };
}
