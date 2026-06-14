// GET /api/slack/oauth/callback
//
// Slack redirects here after the user clicks "Allow" on the consent page.
// We verify the HMAC-signed state, exchange the temporary `code` for a bot
// token, and persist a (slack_workspaces, slack_credentials) pair scoped to
// the signed-in Clerk user.
//
// All exits land back at /settings with a query param the SettingsView reads
// to show a toast (success / error class). The query params are intentionally
// stable strings so SettingsView can switch on them.
//
// State verification is COOKIELESS — see src/lib/slack/oauth.ts for why.
// Callback re-fetches the clerkUserId from the session and recomputes the
// HMAC; mismatch = state_invalid. No cookie reads, no cookie deletions.
//
// Re-connect semantics:
//   - slack_workspaces.unique(user_id, team_id) means a re-connect of the
//     same Slack team reuses the existing workspace row. We upsert with
//     ignoreDuplicates:false so we refresh team_name, set status='active',
//     and clear disconnected_at.
//   - slack_credentials is keyed by workspace_id (1:1). Upsert overwrites
//     bot_token since Slack issues a fresh token on every reconnect.

import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import { exchangeCode, verifyState, siteOrigin } from "@/lib/slack/oauth";

export const runtime = "nodejs";

function redirectToSettings(req: NextRequest, query: string): NextResponse {
  return NextResponse.redirect(new URL(`/settings?${query}`, req.url));
}

export async function GET(req: NextRequest) {
  // 1. Clerk session gate. The state verification requires the clerkUserId
  //    that signed the state, so unauthenticated users can't reach this path.
  const resolved = await resolveUser(req);
  if (!resolved.ok) {
    // Preserve callback URL so post-sign-in Clerk bounces back here with
    // the same ?code/?state and we can finish the exchange.
    const signIn = new URL("/sign-in", siteOrigin());
    const callbackPath = `/api/slack/oauth/callback${req.nextUrl.search}`;
    signIn.searchParams.set("redirect_url", callbackPath);
    return NextResponse.redirect(signIn);
  }
  const { supabaseUserId, clerkUserId } = resolved.user;

  // 2. Query-string params from Slack.
  const code = req.nextUrl.searchParams.get("code");
  const stateFromQuery = req.nextUrl.searchParams.get("state");
  const slackError = req.nextUrl.searchParams.get("error");

  // User clicked "Cancel" on Slack's consent page — Slack appends ?error=access_denied.
  // Whitelist the one known code; anything else collapses to exchange_failed so
  // we don't leak Slack-internal error strings (invalid_scope, etc.) into the URL.
  if (slackError) {
    const mapped = slackError === "access_denied" ? "access_denied" : "exchange_failed";
    return redirectToSettings(req, `slack_error=${mapped}`);
  }
  if (!code || !stateFromQuery) {
    return redirectToSettings(req, "slack_error=missing_params");
  }

  // 3. CSRF: verify the HMAC-signed state binds to THIS user's clerkUserId.
  //    A leaked state for user A won't verify in user B's session because
  //    the sig was computed over user A's clerkUserId.
  if (!verifyState(stateFromQuery, clerkUserId)) {
    return redirectToSettings(req, "slack_error=state_invalid");
  }

  // 4. Exchange code → bot token. Slack errors here are rare but possible
  //    (code already used, code expired, invalid_client). Surface as a
  //    single 'exchange_failed' to the UI — the operator can dig into logs.
  let exchange;
  try {
    exchange = await exchangeCode(code);
  } catch (err) {
    console.error("[slack:oauth:callback] exchangeCode failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return redirectToSettings(req, "slack_error=exchange_failed");
  }

  // 5. Upsert slack_workspaces. onConflict targets the unique (user_id, team_id)
  //    composite — a reconnect of the same team reuses the row and clears the
  //    disconnected_at marker.
  const supabase = makeSupabaseServerClient();
  const nowIso = new Date().toISOString();
  const { data: workspaceRow, error: workspaceErr } = await supabase
    .from("slack_workspaces")
    .upsert(
      {
        user_id: supabaseUserId,
        team_id: exchange.team.id,
        team_name: exchange.team.name,
        bot_user_id: exchange.bot.user_id,
        scope: exchange.scope,
        status: "active",
        connected_at: nowIso,
        disconnected_at: null,
      },
      {
        onConflict: "user_id,team_id",
        ignoreDuplicates: false,
      },
    )
    .select("id")
    .single();

  if (workspaceErr || !workspaceRow) {
    console.error("[slack:oauth:callback] slack_workspaces upsert failed", {
      supabaseUserId,
      teamId: exchange.team.id,
      message: workspaceErr?.message,
    });
    return redirectToSettings(req, "slack_error=workspace_write_failed");
  }

  const workspaceId = workspaceRow.id as string;

  // 6. Upsert slack_credentials. workspace_id is PK, so the conflict target
  //    is the natural key. Both tokens always get refreshed since reconnects
  //    return fresh values. user_token is the load-bearing piece for ingest
  //    (see /start route comment for why bot tokens can't read user DMs).
  //
  //    Log + warn if user_token is null — that means the Slack manifest
  //    is misconfigured (no user_scope set) and ingest will skip this
  //    workspace on every firing until the manifest is fixed and the user
  //    reconnects. We don't fail the OAuth flow because the bot install
  //    can still proceed; we just won't ingest until reconnect.
  if (!exchange.userToken) {
    console.warn("[slack:oauth:callback] no user_token in exchange — ingest will skip", {
      workspaceId,
      teamId: exchange.team.id,
      userScope: exchange.userScope,
    });
  }
  const { error: credErr } = await supabase
    .from("slack_credentials")
    .upsert(
      {
        workspace_id: workspaceId,
        bot_token: exchange.bot.token,
        user_token: exchange.userToken,
        updated_at: nowIso,
      },
      { onConflict: "workspace_id", ignoreDuplicates: false },
    );

  if (credErr) {
    console.error("[slack:oauth:callback] slack_credentials upsert failed", {
      workspaceId,
      message: credErr.message,
    });
    return redirectToSettings(req, "slack_error=credentials_write_failed");
  }

  // 7. Success.
  return redirectToSettings(req, "slack_connected=1");
}
