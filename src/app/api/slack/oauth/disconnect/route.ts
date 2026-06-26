import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// POST /api/slack/oauth/disconnect
//
// Soft-disconnects the user's active Slack workspace(s). Mirrors the Google
// Calendar pattern in src/app/api/dashboard/calendar-status/route.ts DELETE:
//   - flip slack_workspaces.status='disconnected' + disconnected_at=now()
//   - null out slack_credentials.bot_token + user_token so any in-flight
//     ingest call fails fast (defense in depth — the cron also filters on
//     workspaces.status='active')
//
// Per Tab 2 Commit 16 spec (log L7000): this is also the "switch workspace"
// flow. After disconnect, the SettingsView card flips to the "Connect
// Slack" state; user re-OAuths and Slack's workspace picker shows on every
// install, so picking a different workspace lands them connected to that
// new one cleanly.
//
// v0 trade-off (parity with Calendar): we do NOT call Slack's token
// revocation endpoint. v1 hardening would add that so the OAuth grant
// is fully removed at Slack's side too.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const resolved = await resolveUser(req);
  if (!resolved.ok) return resolved.response;
  const { supabaseUserId } = resolved.user;

  const supabase = makeSupabaseServerClient();

  // Scope to active rows only — disconnecting an already-disconnected
  // workspace would silently succeed and confuse the UI.
  const { data: workspaces, error: wsErr } = await supabase
    .from("slack_workspaces")
    .update({
      status: "disconnected",
      disconnected_at: new Date().toISOString(),
    })
    .eq("user_id", supabaseUserId)
    .eq("status", "active")
    .select("id");

  if (wsErr) {
    console.error("[slack/disconnect] workspaces update failed", {
      supabaseUserId,
      message: wsErr.message,
    });
    return NextResponse.json(
      { ok: false, error: "workspaces_update_failed" },
      { status: 500 },
    );
  }

  if (!workspaces || workspaces.length === 0) {
    return NextResponse.json(
      { ok: false, error: "no_active_connection" },
      { status: 404 },
    );
  }

  const workspaceIds = workspaces.map((w) => w.id);

  // Delete credential rows. bot_token + user_token are NOT NULL per
  // migration 0014/0018, so a nulling UPDATE would trip the constraint.
  // DELETE is the cleanest gate: the OAuth callback re-inserts on
  // reconnect. ON DELETE CASCADE from slack_workspaces would also clean
  // up if we deleted the workspace row, but we keep workspace rows for
  // historical disconnected_at tracking.
  const { error: credErr } = await supabase
    .from("slack_credentials")
    .delete()
    .in("workspace_id", workspaceIds);

  if (credErr) {
    // Non-fatal — workspaces are already disconnected so the cron skips
    // them. Log and continue.
    console.warn("[slack/disconnect] credentials null failed", {
      supabaseUserId,
      workspaceIds,
      message: credErr.message,
    });
  }

  return NextResponse.json({ ok: true, disconnected: workspaces.length });
}
