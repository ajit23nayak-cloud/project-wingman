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

  const state = generateState(userId);

  const slackAuthUrl = new URL("https://slack.com/oauth/v2/authorize");
  slackAuthUrl.searchParams.set("client_id", clientId);
  slackAuthUrl.searchParams.set("scope", SLACK_SCOPES.join(","));
  slackAuthUrl.searchParams.set(
    "redirect_uri",
    `${siteOrigin()}/api/slack/oauth/callback`,
  );
  slackAuthUrl.searchParams.set("state", state);

  return NextResponse.redirect(slackAuthUrl);
}
