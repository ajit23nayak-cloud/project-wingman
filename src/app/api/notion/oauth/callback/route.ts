// GET /api/notion/oauth/callback
//
// Notion redirects here after the user clicks "Allow access" on the consent
// page. We verify the HMAC-signed state, exchange the temporary `code` for a
// workspace access token, and persist a (notion_integrations,
// notion_credentials) pair scoped to the signed-in Clerk user.
//
// All exits land back at /settings with a query param the SettingsView reads
// to show a toast (success / error class). Error codes are a stable whitelist
// so SettingsView can switch on them.
//
// State verification is COOKIELESS — see src/lib/notion/oauth.ts for why.
//
// Re-connect semantics:
//   - notion_integrations.unique(user_id, workspace_id) means a re-connect
//     of the same workspace reuses the existing row. We upsert with
//     ignoreDuplicates:false so we refresh workspace_name, workspace_icon,
//     bot_id, set status='active', and clear disconnected_at.
//   - notion_credentials is keyed by integration_id (1:1). Upsert overwrites
//     access_token — Notion issues a fresh token on every reconnect.
//
// Flag E: Notion access tokens don't expire by default. No refresh_token to
// store, no refresh path to run.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import { exchangeCode, verifyState, siteOrigin } from "@/lib/notion/oauth";

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
    const callbackPath = `/api/notion/oauth/callback${req.nextUrl.search}`;
    signIn.searchParams.set("redirect_url", callbackPath);
    return NextResponse.redirect(signIn);
  }

  // 2. Query-string params from Notion.
  const code = req.nextUrl.searchParams.get("code");
  const stateFromQuery = req.nextUrl.searchParams.get("state");
  const notionError = req.nextUrl.searchParams.get("error");

  // User clicked "Cancel" on Notion's consent page — Notion appends ?error=access_denied
  // (same as Slack). Whitelist the one known code; anything else collapses to
  // exchange_failed so we don't leak Notion-internal error strings into the URL.
  if (notionError) {
    const mapped =
      notionError === "access_denied" ? "access_denied" : "exchange_failed";
    return redirectToSettings(req, `notion_error=${mapped}`);
  }
  if (!code || !stateFromQuery) {
    return redirectToSettings(req, "notion_error=missing_params");
  }

  // 3. CSRF: verify the HMAC-signed state binds to THIS user's clerkUserId
  //    BEFORE invoking resolveUser. A forged state fails here and we never
  //    touch the users table.
  if (!verifyState(stateFromQuery, clerkUserId)) {
    return redirectToSettings(req, "notion_error=state_invalid");
  }

  // 4. State verified — now resolve the Supabase user (may auto-create row).
  const resolved = await resolveUser(req);
  if (!resolved.ok) {
    return redirectToSettings(req, "notion_error=integration_write_failed");
  }
  const { supabaseUserId } = resolved.user;

  // 5. Exchange code → access token. Errors here are rare but possible
  //    (code already used, code expired, invalid_client). Surface as a
  //    single 'exchange_failed' to the UI.
  let exchange;
  try {
    exchange = await exchangeCode(code);
  } catch (err) {
    console.error("[notion:oauth:callback] exchangeCode failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return redirectToSettings(req, "notion_error=exchange_failed");
  }

  // 5. Upsert notion_integrations. onConflict targets the unique
  //    (user_id, workspace_id) composite — a reconnect of the same workspace
  //    reuses the row and clears the disconnected_at marker.
  const supabase = makeSupabaseServerClient();
  const nowIso = new Date().toISOString();
  const { data: integrationRow, error: integrationErr } = await supabase
    .from("notion_integrations")
    .upsert(
      {
        user_id: supabaseUserId,
        workspace_id: exchange.workspace.id,
        workspace_name: exchange.workspace.name,
        workspace_icon: exchange.workspace.icon,
        bot_id: exchange.botId,
        status: "active",
        connected_at: nowIso,
        disconnected_at: null,
      },
      {
        onConflict: "user_id,workspace_id",
        ignoreDuplicates: false,
      },
    )
    .select("id")
    .single();

  if (integrationErr || !integrationRow) {
    console.error("[notion:oauth:callback] notion_integrations upsert failed", {
      supabaseUserId,
      workspaceId: exchange.workspace.id,
      message: integrationErr?.message,
    });
    return redirectToSettings(req, "notion_error=integration_write_failed");
  }

  const integrationId = integrationRow.id as string;

  // 6. Upsert notion_credentials. integration_id is PK + the conflict target.
  //    access_token gets refreshed since reconnects return a fresh value.
  const { error: credErr } = await supabase
    .from("notion_credentials")
    .upsert(
      {
        integration_id: integrationId,
        access_token: exchange.accessToken,
        updated_at: nowIso,
      },
      { onConflict: "integration_id", ignoreDuplicates: false },
    );

  if (credErr) {
    console.error("[notion:oauth:callback] notion_credentials upsert failed", {
      integrationId,
      message: credErr.message,
    });
    return redirectToSettings(req, "notion_error=credentials_write_failed");
  }

  // 7. Success.
  return redirectToSettings(req, "notion_connected=1");
}
