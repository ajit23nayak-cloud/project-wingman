import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// GET /api/contacts
//
// Personal CRM list endpoint. Returns the signed-in user's contacts filtered
// by one of four bucket views the dashboard renders as tabs:
//
//   - cadence-break: people I usually hear from but haven't in a while.
//     cadence_break_days is computed by the contacts roll-up job; we just
//     surface rows where it's non-null and rank by how overdue + how big
//     the relationship is.
//   - recent: most recently touched (any source). The default "who am I
//     talking to" view.
//   - all: alphabetical address book, excludes archived.
//   - archived: explicitly opted-out rows only.
//
// Service-role client + explicit user_id filter, matching the dashboard/me
// pattern. Browser never sees the service role; this route is the only path.

export const runtime = "nodejs";

const ALLOWED_FILTERS = new Set(["cadence-break", "recent", "all", "archived"]);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(req: NextRequest) {
  const resolved = await resolveUser(req);
  if (!resolved.ok) return resolved.response;
  const { supabaseUserId } = resolved.user;

  const { searchParams } = new URL(req.url);
  const filterRaw = searchParams.get("filter") ?? "all";
  const filter = ALLOWED_FILTERS.has(filterRaw) ? filterRaw : "all";

  // Clamp limit to [1, MAX_LIMIT]. Bogus values fall back to DEFAULT_LIMIT
  // rather than 400 — these come from the UI, not user input we need to
  // strictly validate.
  const limitRaw = Number.parseInt(searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, MAX_LIMIT)
    : DEFAULT_LIMIT;

  const supabase = makeSupabaseServerClient();
  let query = supabase
    .from("contacts")
    .select("*")
    .eq("user_id", supabaseUserId);

  if (filter === "cadence-break") {
    // Snooze-aware: hide rows whose snoozed_until is in the future. Other
    // views (recent/all/archived) are direct management surfaces and stay
    // unfiltered so the user can find + unsnooze a contact intentionally.
    query = query
      .not("cadence_break_days", "is", null)
      .eq("archived", false)
      .or(`snoozed_until.is.null,snoozed_until.lte.${new Date().toISOString()}`)
      .order("cadence_break_days", { ascending: false })
      .order("total_interactions_lifetime", { ascending: false });
  } else if (filter === "recent") {
    query = query
      .eq("archived", false)
      .order("last_seen_at", { ascending: false });
  } else if (filter === "archived") {
    query = query
      .eq("archived", true)
      .order("display_name", { ascending: true });
  } else {
    // all
    query = query
      .eq("archived", false)
      .order("display_name", { ascending: true });
  }

  const { data, error } = await query.limit(limit);
  if (error) {
    console.error("[contacts/GET] select failed", {
      supabaseUserId,
      filter,
      message: error.message,
    });
    return NextResponse.json({ error: "select_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, contacts: data ?? [] });
}
