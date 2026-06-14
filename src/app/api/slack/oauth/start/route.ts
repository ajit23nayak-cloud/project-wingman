// GET /api/slack/oauth/start
//
// Entry point for the Slack workspace connect flow. Requires a Clerk session
// (we attribute the incoming Slack workspace to a user, and the state mechanism
// binds the OAuth roundtrip to that user's clerkUserId).
//
// Sequence:
//   1. Gate on Clerk session — bounce to /sign-in (with redirect_url) if absent.
//   2. Generate a signed state value (`nonce.sig` bound to clerkUserId — see
//      src/lib/slack/oauth.ts). NO cookie — multi-hostname Vercel deploys
//      break cookie-bound CSRF state.
//   3. Redirect to Slack's consent page with the signed state as `state=`.
//      Slack echoes it back to /callback verbatim; callback re-fetches the
//      clerkUserId from session and validates the HMAC.
//
// Bot scopes (mostly future-proofing — Wingman's ingest path doesn't actually
// use bot APIs, but we keep the bot user installed for any v1 bot-side
// features like status pings):
//   im:history  — read message history in DMs the bot is in
//   im:read     — list/inspect those DM channels
//   users:read  — resolve user IDs to display names
//   team:read   — workspace name + id for slack_workspaces rows
//
// USER scopes (this is the load-bearing piece — bot tokens with im:history
// only read DMs where the bot is a participant, NOT the user's 1:1 DMs with
// other humans. The 2026-06-14 Phase 1 verification surfaced this: 0 messages
// ingested in 13 hours of cron firings because we'd only requested bot
// scopes. user_scope= adds the user token to the OAuth response, which the
// ingest cron uses for conversations.list / history / users.info):
//   im:history  — same as bot but on behalf of the user
//   im:read
//   users:read

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { generateState, siteOrigin } from "@/lib/slack/oauth";

export const runtime = "nodejs";

const BOT_SCOPES = ["im:history", "im:read", "users:read", "team:read"];
const USER_SCOPES = ["im:history", "im:read", "users:read"];

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

  const state = generateState(userId);

  const slackAuthUrl = new URL("https://slack.com/oauth/v2/authorize");
  slackAuthUrl.searchParams.set("client_id", clientId);
  slackAuthUrl.searchParams.set("scope", BOT_SCOPES.join(","));
  slackAuthUrl.searchParams.set("user_scope", USER_SCOPES.join(","));
  slackAuthUrl.searchParams.set(
    "redirect_uri",
    `${siteOrigin()}/api/slack/oauth/callback`,
  );
  slackAuthUrl.searchParams.set("state", state);

  return NextResponse.redirect(slackAuthUrl);
}
