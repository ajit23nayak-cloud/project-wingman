import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// GET /api/mh/streak
//
// Returns the current consecutive-day streak. Definition per Tab 2 19:10 UTC
// lock flag B: any ritual entry (morning OR evening) on a calendar date
// counts as 1 day. Lenient — "no shame for breaks" per MH_UI_SPEC.md L62.
//
// Computation: pull all distinct UTC calendar dates with at least one
// mh_sessions row of type ritual ('morning_ritual' or 'evening_ritual'),
// ordered newest first. Walk backward from today; increment streak while
// the next-expected-day is in the set; stop at first gap.
//
// Cost: O(N) where N = total ritual rows. For v0 single-user with one row
// per day per type, that's ~60 rows for two months. Fine. Will revisit if
// the table grows past tens of thousands.

export const runtime = "nodejs";

function dateKey(d: Date): string {
  // YYYY-MM-DD in UTC
  return d.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  const result = await resolveUser(req);
  if (!result.ok) return result.response;
  const { supabaseUserId } = result.user;

  const supabase = makeSupabaseServerClient();

  const { data, error } = await supabase
    .from("mh_sessions")
    .select("created_at")
    .eq("user_id", supabaseUserId)
    .in("type", ["morning_ritual", "evening_ritual"])
    .order("created_at", { ascending: false })
    .limit(400); // ~13 months of two-per-day; far more than v0 needs

  if (error) {
    console.error("[mh/streak] select failed", {
      supabaseUserId,
      message: error.message,
    });
    return NextResponse.json(
      { streakDays: 0, error: "lookup_failed" },
      { status: 500 },
    );
  }

  const days = new Set<string>();
  for (const row of data ?? []) {
    days.add(dateKey(new Date(row.created_at)));
  }

  // Walk back from today. If today has no entry, the streak starts from
  // yesterday — a user who hasn't done today's ritual yet shouldn't see
  // their streak drop to 0 mid-morning.
  let streak = 0;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const cursor = new Date(today);

  // First check today; if missing, allow grace and start from yesterday.
  if (!days.has(dateKey(cursor))) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  while (days.has(dateKey(cursor))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  return NextResponse.json({ streakDays: streak });
}
