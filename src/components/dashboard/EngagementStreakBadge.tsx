"use client";

// Wingman engagement streak badge — "Day N with Wingman" (Mega-commit B
// 13a #18). Renders next to UserButton in the dashboard header. DISTINCT
// from the MH ritual streak (shown inline on the "Daily ritual" button
// via useStreak). Naming decision locked by Ajit 2026-06-25 (b).
//
// On mount: fires /api/streak/increment ONCE per session via sessionStorage
// guard. The route is server-side idempotent per day, but the session guard
// avoids the network round-trip on subsequent dashboard mounts in the same
// tab session.

import { useEffect, useRef } from "react";
import {
  useEngagementStreak,
  useIncrementEngagementStreak,
} from "@/lib/supabase/hooks";

const SESSION_KEY = "wingman_engagement_streak_incremented_today";

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

function milestoneGlyph(streak: number): string | null {
  if (streak >= 100) return "★";
  if (streak >= 30) return "✦";
  if (streak >= 7) return "·";
  return null;
}

export function EngagementStreakBadge() {
  const { data, mutate } = useEngagementStreak();
  const increment = useIncrementEngagementStreak();
  const firedRef = useRef(false);

  // Fire-once-per-session increment. Session guard keyed on today's date so
  // a tab kept open past midnight still re-fires the next day.
  useEffect(() => {
    if (firedRef.current) return;
    if (typeof window === "undefined") return;
    const stored = window.sessionStorage.getItem(SESSION_KEY);
    if (stored === todayYmd()) {
      firedRef.current = true;
      return;
    }
    firedRef.current = true;
    void (async () => {
      const res = await increment();
      if (res.ok) {
        window.sessionStorage.setItem(SESSION_KEY, todayYmd());
        void mutate();
      }
    })();
    // increment + mutate are stable references; ESLint exhaustive-deps isn't
    // configured to care about hook identities here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!data) return null;

  const streak = data.currentStreak;
  const glyph = milestoneGlyph(streak);
  const label =
    streak === 0
      ? "Welcome — Day 1 with Wingman"
      : `Day ${streak} with Wingman`;

  return (
    <span
      aria-label={`Engagement streak: ${streak} days`}
      title={`Longest streak: ${data.longestStreak} days · Total days active: ${data.totalDaysActive}`}
      className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-900"
    >
      {glyph && <span aria-hidden="true">{glyph}</span>}
      {label}
    </span>
  );
}
