// GET /api/slack/oauth/start
//
// Entry point for the Slack workspace connect flow. Requires a Clerk session
// (we can't attribute an incoming Slack workspace to a user otherwise).
//
// Sequence:
//   1. Gate on Clerk session — bounce to /sign-in if absent.
//   2. Generate a random nonce, HMAC-sign it (see src/lib/slack/oauth.ts),
//      stash the signed value in an HTTP-only cookie (10 min TTL).
//   3. Redirect to Slack's consent page with the bare nonce as `state=`.
//      Slack will echo it back to /callback, where we verify it against
//      the cookie to defeat CSRF.
//
// Scopes (bot-only, per the blast-radius lock — no user-token scopes):
//   im:history  — read message history in DMs the bot is in
//   im:read     — list/inspect those DM channels
//   users:read  — resolve user IDs to display names for the classifier
//   team:read   — workspace name + id for slack_workspaces rows

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { generateState, siteOrigin } from "@/lib/slack/oauth";

export const runtime = "nodejs";

const SLACK_SCOPES = ["im:history", "im:read", "users:read", "team:read"];

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    // Pass the Slack-connect intent so Clerk bounces back here after sign-in
    // and the user finishes the flow rather than landing on /dashboard.
    const signIn = new URL("/sign-in", siteOrigin());
    signIn.searchParams.set("redirect_url", "/api/slack/oauth/start");
    return NextResponse.redirect(signIn);
  }

  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "slack_client_id_missing" },
      { status: 500 },
    );
  }

  const { nonce, cookieValue } = generateState();

  const slackAuthUrl = new URL("https://slack.com/oauth/v2/authorize");
  slackAuthUrl.searchParams.set("client_id", clientId);
  slackAuthUrl.searchParams.set("scope", SLACK_SCOPES.join(","));
  slackAuthUrl.searchParams.set(
    "redirect_uri",
    `${siteOrigin()}/api/slack/oauth/callback`,
  );
  slackAuthUrl.searchParams.set("state", nonce);

  // NextResponse.redirect + .cookies.set keeps both the 302 Location header
  // AND the Set-Cookie header in one response (cookies() from next/headers
  // can't co-exist with a redirect in a single handler return).
  const response = NextResponse.redirect(slackAuthUrl);
  response.cookies.set("slack_oauth_state", cookieValue, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600, // 10 minutes — Slack consent usually resolves in <60s
    path: "/",
  });
  return response;
}
