// GET /api/notion/oauth/start
//
// Entry point for the Notion workspace connect flow. Mirrors the Slack
// /start route exactly:
//   1. Gate on Clerk session — bounce to /sign-in (with redirect_url) if absent.
//   2. Generate a signed state value (`nonce.sig` bound to clerkUserId — see
//      src/lib/notion/oauth.ts). NO cookie — multi-hostname Vercel deploys
//      break cookie-bound CSRF state.
//   3. Redirect to Notion's consent page with the signed state as `state=`.
//      Notion echoes it back to /callback verbatim; callback re-fetches the
//      clerkUserId from session and validates the HMAC.
//
// Notion-specific authorize params:
//   client_id      — the public OAuth client id from Notion integration config
//   response_type  — always "code" (Notion OAuth v2)
//   owner          — "user" (picks a single workspace via personal consent)
//   redirect_uri   — must exact-match what's registered in Notion config
//   state          — the nonce.sig signed value
//
// Notion doesn't have a `scope=` param like Slack — capabilities are
// configured in the integration settings dashboard, not the URL.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { generateState, siteOrigin } from "@/lib/notion/oauth";

export const runtime = "nodejs";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    // Pass the Notion-connect intent so Clerk bounces back here after sign-in
    // and the user finishes the flow rather than landing on /dashboard.
    const signIn = new URL("/sign-in", siteOrigin());
    signIn.searchParams.set("redirect_url", "/api/notion/oauth/start");
    return NextResponse.redirect(signIn);
  }

  const clientId = process.env.NOTION_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "notion_client_id_missing" },
      { status: 500 },
    );
  }

  const state = generateState(userId);

  const notionAuthUrl = new URL("https://api.notion.com/v1/oauth/authorize");
  notionAuthUrl.searchParams.set("client_id", clientId);
  notionAuthUrl.searchParams.set("response_type", "code");
  notionAuthUrl.searchParams.set("owner", "user");
  notionAuthUrl.searchParams.set(
    "redirect_uri",
    `${siteOrigin()}/api/notion/oauth/callback`,
  );
  notionAuthUrl.searchParams.set("state", state);

  return NextResponse.redirect(notionAuthUrl);
}
