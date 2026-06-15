// GET /api/google/calendar/oauth/callback
//
// Google redirects here after the user clicks "Allow" on the consent screen.
// Mirrors src/app/api/notion/oauth/callback/route.ts exactly — including the
// post-review fix where auth() runs FIRST to get clerkUserId, state is
// verified BEFORE resolveUser (so a forged state with a fake clerkUserId
// doesn't auto-create a users row).
//
// All exits land on /settings with a query param the SettingsView reads to
// show a toast. Error codes are a stable whitelist so SettingsView can
// switch on them.
//
// Re-connect semantics:
//   calendar_credentials is keyed by user_id (PK). Upsert with
//   onConflict='user_id' refreshes access_token, refresh_token,
//   token_expires_at, scope, clears disconnected_at, and bumps connected_at.
//
//   On THIS path (grant_type=authorization_code WITH prompt=consent always
//   set), Google always returns a fresh refresh_token. The COALESCE concern
//   from the spec (D3) applies only to the refresh-token flow (grant_type=
//   refresh_token), which is in the ingest cron's refresh path — not here.
//   exchangeCode() throws if refresh_token is missing, so refreshToken is
//   always non-null at this point.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import {
  exchangeCode,
  verifyState,
  siteOrigin,
} from "@/lib/google/calendar/oauth";

export const runtime = "nodejs";

function redirectToSettings(req: NextRequest, query: string): NextResponse {
  return NextResponse.redirect(new URL(`/settings?${query}`, req.url));
}

export async function GET(req: NextRequest) {
  // 1. Get clerkUserId from session BEFORE resolveUser. resolveUser auto-
  //    creates a Supabase users row on first call, and we don't want a
  //    forged state with a fake clerkUserId to land a users row before
  //    failing state_invalid. Verify state first, then resolveUser.
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) {
    const signIn = new URL("/sign-in", siteOrigin());
    const callbackPath = `/api/google/calendar/oauth/callback${req.nextUrl.search}`;
    signIn.searchParams.set("redirect_url", callbackPath);
    return NextResponse.redirect(signIn);
  }

  // 2. Query-string params from Google.
  const code = req.nextUrl.searchParams.get("code");
  const stateFromQuery = req.nextUrl.searchParams.get("state");
  const googleError = req.nextUrl.searchParams.get("error");

  // 3. CSRF: verify the HMAC-signed state binds to THIS user's clerkUserId
  //    BEFORE doing ANYTHING else (including reading Google's ?error= param).
  //    Otherwise an attacker can craft /callback?error=access_denied&state=x
  //    that always reaches the toast-redirect path without a valid state,
  //    enabling fake-cancellation toast spam on any logged-in victim.
  if (!stateFromQuery || !verifyState(stateFromQuery, clerkUserId)) {
    return redirectToSettings(req, "calendar_error=state_invalid");
  }

  // User clicked "Cancel" on Google's consent screen — Google appends
  // ?error=access_denied. Whitelist the known code; anything else collapses
  // to exchange_failed so we don't leak Google-internal error strings into
  // the URL.
  if (googleError) {
    const mapped =
      googleError === "access_denied" ? "access_denied" : "exchange_failed";
    return redirectToSettings(req, `calendar_error=${mapped}`);
  }
  if (!code) {
    return redirectToSettings(req, "calendar_error=missing_params");
  }

  // 4. State verified — now resolve the Supabase user (may auto-create row).
  const resolved = await resolveUser(req);
  if (!resolved.ok) {
    return redirectToSettings(req, "calendar_error=credentials_write_failed");
  }
  const { supabaseUserId } = resolved.user;

  // 5. Exchange code → access_token + refresh_token + expires_in.
  //    exchangeCode throws if refresh_token is missing (which would mean the
  //    start URL forgot access_type=offline / prompt=consent — surface
  //    immediately, not at hour 1).
  let exchange;
  try {
    exchange = await exchangeCode(code);
  } catch (err) {
    console.error("[google:calendar:oauth:callback] exchangeCode failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return redirectToSettings(req, "calendar_error=exchange_failed");
  }

  // 6. Upsert calendar_credentials. user_id is the PK + conflict target.
  //    Reconnects refresh everything and clear disconnected_at.
  const supabase = makeSupabaseServerClient();
  const nowIso = new Date().toISOString();
  const { error: credErr } = await supabase
    .from("calendar_credentials")
    .upsert(
      {
        user_id: supabaseUserId,
        access_token: exchange.accessToken,
        refresh_token: exchange.refreshToken,
        token_expires_at: exchange.expiresAt.toISOString(),
        scope: exchange.scope,
        status: "active",
        connected_at: nowIso,
        disconnected_at: null,
        updated_at: nowIso,
      },
      {
        onConflict: "user_id",
        ignoreDuplicates: false,
      },
    );

  if (credErr) {
    console.error(
      "[google:calendar:oauth:callback] calendar_credentials upsert failed",
      {
        supabaseUserId,
        message: credErr.message,
      },
    );
    return redirectToSettings(req, "calendar_error=credentials_write_failed");
  }

  // 7. Success.
  return redirectToSettings(req, "calendar_connected=1");
}
