// GET /api/google/calendar/oauth/start
//
// Entry point for the Google Calendar connect flow. Mirrors the Slack/Notion
// start route. Requires a Clerk session — we attribute the incoming calendar
// grant to a user, and the HMAC state mechanism binds the OAuth roundtrip
// to that user's clerkUserId.
//
// Sequence:
//   1. Gate on Clerk session — bounce to /sign-in (with redirect_url) if absent.
//   2. Generate a signed state (`nonce.sig` bound to clerkUserId — see
//      src/lib/google/calendar/oauth.ts). NO cookie — multi-hostname Vercel
//      deploys break cookie-bound CSRF.
//   3. Redirect to Google's consent screen with:
//        - scope=https://www.googleapis.com/auth/calendar.readonly  (read-only)
//        - access_type=offline + prompt=consent (MANDATORY for refresh_token)
//        - include_granted_scopes=true (don't drop prior Gmail grants — this
//          is an incremental scope add)
//        - state=${state}
//
// Note: uses GOOGLE_OAUTH_CLIENT_ID — the SAME client_id as Gmail OAuth in
// the existing Google Cloud project, but a separate consent grant (the user
// gets a Google consent screen the first time they connect calendar even if
// Gmail is already wired). Refresh token + access token land in
// calendar_credentials, not the Clerk-managed Gmail token store.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  generateState,
  siteOrigin,
  CALENDAR_SCOPES,
} from "@/lib/google/calendar/oauth";

export const runtime = "nodejs";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    // Pass the calendar-connect intent through Clerk so the user lands back
    // on this start route after sign-in, not on /dashboard.
    const signIn = new URL("/sign-in", siteOrigin());
    signIn.searchParams.set("redirect_url", "/api/google/calendar/oauth/start");
    return NextResponse.redirect(signIn);
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "google_oauth_client_id_missing" },
      { status: 500 },
    );
  }

  const state = generateState(userId);

  const googleAuthUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  googleAuthUrl.searchParams.set("client_id", clientId);
  googleAuthUrl.searchParams.set(
    "redirect_uri",
    `${siteOrigin()}/api/google/calendar/oauth/callback`,
  );
  googleAuthUrl.searchParams.set("response_type", "code");
  googleAuthUrl.searchParams.set("scope", CALENDAR_SCOPES.join(" "));
  // MANDATORY pair for refresh_token issuance. Without these, Google omits
  // refresh_token from the exchange response and we hit silent re-auth
  // failures after the first hour when the access token expires.
  googleAuthUrl.searchParams.set("access_type", "offline");
  googleAuthUrl.searchParams.set("prompt", "consent");
  // Don't drop prior Gmail grants — this is an incremental scope add.
  googleAuthUrl.searchParams.set("include_granted_scopes", "true");
  googleAuthUrl.searchParams.set("state", state);

  return NextResponse.redirect(googleAuthUrl);
}
