import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// GET /api/mh/ritual/today
//
// Returns today's morning + evening ritual rows (if any) for /daily prefill.
// Allows the page to render with prior answers populated so the user can
// edit rather than re-fill.
//
// Shape: { morning: SessionRow | null, evening: SessionRow | null }
// SessionRow shape pinned per CONVENTIONS.md rule 2 — see frontend hook
// type definition (useTodayRitual).

export const runtime = "nodejs";

function dayBoundsUtc(date: Date): { start: string; end: string } {
  const start = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

export async function GET(req: NextRequest) {
  const result = await resolveUser(req);
  if (!result.ok) return result.response;
  const { supabaseUserId } = result.user;

  const supabase = makeSupabaseServerClient();
  const today = dayBoundsUtc(new Date());

  const { data, error } = await supabase
    .from("mh_sessions")
    .select("id, type, framework_used, numeric_data, text_data, created_at")
    .eq("user_id", supabaseUserId)
    .in("type", ["morning_ritual", "evening_ritual"])
    .gte("created_at", today.start)
    .lt("created_at", today.end)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[mh/ritual/today] select failed", {
      supabaseUserId,
      message: error.message,
    });
    return NextResponse.json(
      { morning: null, evening: null, error: "lookup_failed" },
      { status: 500 },
    );
  }

  const morning =
    (data ?? []).find((r) => r.type === "morning_ritual") ?? null;
  const evening =
    (data ?? []).find((r) => r.type === "evening_ritual") ?? null;

  return NextResponse.json({ morning, evening });
}
