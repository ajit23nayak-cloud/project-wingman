import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// GET /api/streak
//
// Returns the user's Wingman engagement streak (consecutive days they've
// opened /dashboard or completed a qualifying action). DISTINCT from the
// MH ritual streak at /api/mh/streak — see useEngagementStreak() vs
// useStreak() in src/lib/supabase/hooks.ts. Naming decision locked by Ajit
// 2026-06-25 (option b: keep both, distinct surfaces).
//
// No row in user_streaks → return zeros (first-time user; the increment
// route inserts on first call).

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const resolved = await resolveUser(req);
  if (!resolved.ok) return resolved.response;
  const { supabaseUserId } = resolved.user;

  const supabase = makeSupabaseServerClient();
  const { data, error } = await supabase
    .from("user_streaks")
    .select("current_streak_days, longest_streak_days, last_activity_date, total_days_active")
    .eq("user_id", supabaseUserId)
    .maybeSingle();

  if (error) {
    console.error("[streak/GET] select failed", {
      supabaseUserId,
      message: error.message,
    });
    return NextResponse.json({ error: "select_failed" }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({
      currentStreak: 0,
      longestStreak: 0,
      lastActivityDate: null,
      totalDaysActive: 0,
    });
  }

  return NextResponse.json({
    currentStreak: data.current_streak_days,
    longestStreak: data.longest_streak_days,
    lastActivityDate: data.last_activity_date,
    totalDaysActive: data.total_days_active,
  });
}
