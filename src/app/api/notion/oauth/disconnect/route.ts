import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// POST /api/notion/oauth/disconnect
//
// Mirror of /api/slack/oauth/disconnect for Notion. Soft-disconnects the
// user's active Notion integration: flips notion_integrations.status to
// 'disconnected' + stamps disconnected_at, then nulls the access_token in
// notion_credentials so any in-flight ingest fails fast.
//
// Same v0 trade-off as Slack/Calendar: we do NOT revoke the OAuth grant
// at Notion's side. Reconnect re-OAuths and Notion shows the workspace
// picker so user can pick a different workspace.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const resolved = await resolveUser(req);
  if (!resolved.ok) return resolved.response;
  const { supabaseUserId } = resolved.user;

  const supabase = makeSupabaseServerClient();

  const { data: integrations, error: intErr } = await supabase
    .from("notion_integrations")
    .update({
      status: "disconnected",
      disconnected_at: new Date().toISOString(),
    })
    .eq("user_id", supabaseUserId)
    .eq("status", "active")
    .select("id");

  if (intErr) {
    console.error("[notion/disconnect] integrations update failed", {
      supabaseUserId,
      message: intErr.message,
    });
    return NextResponse.json(
      { ok: false, error: "integrations_update_failed" },
      { status: 500 },
    );
  }

  if (!integrations || integrations.length === 0) {
    return NextResponse.json(
      { ok: false, error: "no_active_connection" },
      { status: 404 },
    );
  }

  const integrationIds = integrations.map((i) => i.id);

  // Delete credential rows. access_token is NOT NULL per migration 0016,
  // so a nulling UPDATE would trip the constraint. OAuth callback re-
  // inserts on reconnect.
  const { error: credErr } = await supabase
    .from("notion_credentials")
    .delete()
    .in("integration_id", integrationIds);

  if (credErr) {
    console.warn("[notion/disconnect] credentials null failed", {
      supabaseUserId,
      integrationIds,
      message: credErr.message,
    });
  }

  return NextResponse.json({ ok: true, disconnected: integrations.length });
}
