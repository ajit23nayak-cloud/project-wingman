import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// POST /api/streak/increment
//
// Idempotent per day. Logic:
//   - No row → INSERT with streak=1, today as last_activity.
//   - Row + last_activity_date = today → no-op (idempotent).
//   - Row + last_activity_date = yesterday → +1 current_streak, bump longest.
//   - Row + last_activity_date < yesterday → reset current_streak=1 (hard
//     reset per v0 spec; no grace day).
//
// ALSO bumps users.last_dashboard_open_at on every call. This drives the
// dashboard-signal-refresh cron's "active in last 24h" gate so we don't
// burn Gemini on inactive users. Single-write follow-up — not transactional
// with the streak update; if the second write fails, the streak stays
// correct and the activity bump retries on next call.

export const runtime = "nodejs";

function ymd(d: Date): string {
  // YYYY-MM-DD in UTC. The migration's last_activity_date is `date` which
  // Postgres stores TZ-naive; using UTC keeps midnight rollover predictable
  // (per-user-tz date math comes later when surfacing the badge).
  return d.toISOString().slice(0, 10);
}

function daysBetween(aIso: string, bIso: string): number {
  const a = new Date(aIso + "T00:00:00Z").getTime();
  const b = new Date(bIso + "T00:00:00Z").getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

export async function POST(req: NextRequest) {
  const resolved = await resolveUser(req);
  if (!resolved.ok) return resolved.response;
  const { supabaseUserId } = resolved.user;

  const supabase = makeSupabaseServerClient();
  const todayStr = ymd(new Date());

  const { data: existing, error: selErr } = await supabase
    .from("user_streaks")
    .select("current_streak_days, longest_streak_days, last_activity_date, total_days_active")
    .eq("user_id", supabaseUserId)
    .maybeSingle();
  if (selErr) {
    console.error("[streak/increment] select failed", {
      supabaseUserId,
      message: selErr.message,
    });
    return NextResponse.json({ error: "select_failed" }, { status: 500 });
  }

  let currentStreak: number;
  let longestStreak: number;
  let totalDaysActive: number;

  if (!existing) {
    currentStreak = 1;
    longestStreak = 1;
    totalDaysActive = 1;
    const { error: insErr } = await supabase.from("user_streaks").insert({
      user_id: supabaseUserId,
      current_streak_days: currentStreak,
      longest_streak_days: longestStreak,
      last_activity_date: todayStr,
      total_days_active: totalDaysActive,
    });
    if (insErr) {
      console.error("[streak/increment] insert failed", {
        supabaseUserId,
        message: insErr.message,
      });
      return NextResponse.json({ error: "insert_failed" }, { status: 500 });
    }
  } else if (existing.last_activity_date === todayStr) {
    currentStreak = existing.current_streak_days;
    longestStreak = existing.longest_streak_days;
    totalDaysActive = existing.total_days_active;
    // No update needed — idempotent per day.
  } else {
    const lastIso = existing.last_activity_date as string | null;
    const gap = lastIso ? daysBetween(lastIso, todayStr) : Infinity;
    if (gap === 1) {
      currentStreak = existing.current_streak_days + 1;
    } else {
      // gap > 1 OR last was null → hard reset.
      currentStreak = 1;
    }
    longestStreak = Math.max(existing.longest_streak_days, currentStreak);
    totalDaysActive = existing.total_days_active + 1;
    const { error: updErr } = await supabase
      .from("user_streaks")
      .update({
        current_streak_days: currentStreak,
        longest_streak_days: longestStreak,
        last_activity_date: todayStr,
        total_days_active: totalDaysActive,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", supabaseUserId);
    if (updErr) {
      console.error("[streak/increment] update failed", {
        supabaseUserId,
        message: updErr.message,
      });
      return NextResponse.json({ error: "update_failed" }, { status: 500 });
    }
  }

  // Bump the activity-pulse used by dashboard-signal-refresh cron. Logged-
  // but-non-fatal — streak data is still good if this fails.
  const { error: pulseErr } = await supabase
    .from("users")
    .update({ last_dashboard_open_at: new Date().toISOString() })
    .eq("id", supabaseUserId);
  if (pulseErr) {
    console.warn("[streak/increment] last_dashboard_open_at update failed", {
      supabaseUserId,
      message: pulseErr.message,
    });
  }

  return NextResponse.json({
    ok: true,
    currentStreak,
    longestStreak,
    totalDaysActive,
  });
}
