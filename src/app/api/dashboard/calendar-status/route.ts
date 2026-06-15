import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// GET /api/dashboard/calendar-status
//
// Returns the calendar_credentials row for the signed-in user PROJECTED to
// status fields only — deliberately omits access_token and refresh_token from
// the SELECT so secrets never reach the browser. The calendar_credentials
// table has RLS-with-zero-policies (browser can't query it directly); this
// service-role route is the only browser-accessible path to credential status.
//
// DELETE /api/dashboard/calendar-status
//
// Soft-disconnects: marks status='disconnected' and stamps disconnected_at.
// Per Tab 1 D2 lock, does NOT call Google's /o/oauth2/revoke — v0 trade-off.
// User can revoke the OAuth grant from their Google account settings if they
// want it fully removed. v1 hardening: add the revoke call here so we don't
// leave dormant grants in the user's Google account.

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const resolved = await resolveUser(req);
  if (!resolved.ok) return resolved.response;

  const supabase = makeSupabaseServerClient();
  const { data, error } = await supabase
    .from("calendar_credentials")
    .select(
      "status, scope, token_expires_at, connected_at, disconnected_at, updated_at",
    )
    .eq("user_id", resolved.user.supabaseUserId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data ?? null);
}

export async function DELETE(req: NextRequest) {
  const resolved = await resolveUser(req);
  if (!resolved.ok) return resolved.response;

  // Scope to status='active' so a DELETE on a non-existent or already-
  // disconnected row returns 404 instead of silently succeeding — the UI
  // shouldn't show "disconnected" without a real state change behind it.
  const supabase = makeSupabaseServerClient();
  const { data, error } = await supabase
    .from("calendar_credentials")
    .update({
      status: "disconnected",
      disconnected_at: new Date().toISOString(),
    })
    .eq("user_id", resolved.user.supabaseUserId)
    .eq("status", "active")
    .select("user_id");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: "no_active_connection" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
