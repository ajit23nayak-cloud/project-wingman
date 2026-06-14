// Notion OAuth helpers: token exchange + HMAC-signed state for CSRF.
//
// Mirrors src/lib/slack/oauth.ts exactly. State mechanism is intentionally
// duplicated (not shared via a common helper) so a future Notion-specific
// hardening (TTL, replay table) doesn't blast-radius into Slack.
//
// State design (CSRF protection on the OAuth roundtrip):
//   - /start generates a random nonce, signs HMAC-SHA256 over
//     `${clerkUserId}.${nonce}` keyed on CLERK_SECRET_KEY, and sends
//     `${nonce}.${sig}` to Notion as the `state=` query param.
//   - /callback re-fetches the clerkUserId from the current session,
//     parses state on the `.` separator, recomputes the HMAC over
//     `${clerkUserId}.${nonce}`, and constant-time-compares the sigs.
//   - Binding state to clerkUserId means a captured state value can't be
//     replayed in a different account — the sig won't match the attacker's
//     clerkUserId. Attacker can't forge new states without CLERK_SECRET_KEY.
//
// Why cookieless: same Vercel multi-hostname issue Slack hit — preview-
// deployment hostname cookies don't travel to production hostname.
//
// KEY DIFFERENCE FROM SLACK: Notion's token endpoint takes a JSON body
// (not form-urlencoded) and uses HTTP Basic auth for client credentials
// (not body params).

import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type NotionOAuthExchangeResult = {
  ok: boolean;
  workspace: { id: string; name: string; icon: string | null };
  botId: string;
  accessToken: string;
  raw: unknown;
};

// siteOrigin: prefer NEXT_PUBLIC_SITE_URL (set in Vercel) so the redirect_uri
// matches what's registered in the Notion integration config. Trim trailing
// slash — Notion's redirect_uri match is exact.
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
    throw new Error("CLERK_SECRET_KEY is not set (needed for state-nonce HMAC)");
  }
  return key;
}

function hmacHex(value: string, key: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

// generateState: returns a single `nonce.sig` string to send to Notion as
// `?state=...`. The sig binds the nonce to the Clerk user so a leaked state
// can't be replayed by a different account.
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
  if (sig.length !== expectedSig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
  } catch {
    return false;
  }
}

// exchangeCode: POSTs Notion's /v1/oauth/token endpoint to swap the temporary
// `code` for the workspace's long-lived access token.
//
// Differences from Slack's flow:
//   - Body is JSON (Content-Type: application/json), not form-urlencoded.
//   - Client credentials go in HTTP Basic auth header, not body params.
//   - Notion-Version header is mandatory.
//
// Token response shape:
//   {
//     access_token: "secret_...",
//     token_type: "bearer",
//     bot_id: "...",
//     workspace_id: "...",
//     workspace_name: "...",
//     workspace_icon: "https://...",
//     owner: { type: "user", user: { id: "..." } },
//     duplicated_template_id: null
//   }
//
// Flag E: tokens DON'T expire by default. No refresh_token, no refresh path.
// Re-auth happens only when the user revokes from Notion settings.
export async function exchangeCode(
  code: string,
): Promise<NotionOAuthExchangeResult> {
  const clientId = process.env.NOTION_CLIENT_ID;
  const clientSecret = process.env.NOTION_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "NOTION_CLIENT_ID / NOTION_CLIENT_SECRET not set — cannot exchange OAuth code",
    );
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const res = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${siteOrigin()}/api/notion/oauth/callback`,
    }),
  });

  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    token_type?: string;
    bot_id?: string;
    workspace_id?: string;
    workspace_name?: string;
    workspace_icon?: string | null;
    owner?: unknown;
    error?: string;
    code?: string;
    message?: string;
  };

  if (!res.ok) {
    throw new Error(
      `notion_oauth_exchange_failed:${json.error ?? json.code ?? res.status}`,
    );
  }

  if (!json.access_token || !json.workspace_id || !json.bot_id) {
    throw new Error("notion_oauth_exchange_missing_fields");
  }

  return {
    ok: true,
    workspace: {
      id: json.workspace_id,
      name: json.workspace_name ?? "",
      icon: json.workspace_icon ?? null,
    },
    botId: json.bot_id,
    accessToken: json.access_token,
    raw: json,
  };
}
