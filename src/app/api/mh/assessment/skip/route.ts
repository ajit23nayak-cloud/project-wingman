import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// POST /api/mh/assessment/skip
//
// No body. Stamps users.mh_assessment_skipped_at = now() and increments
// mh_assessment_skip_count. Dashboard banner uses these two columns to
// decide whether to re-show the assessment nudge:
//   - First skip: skipped_at = now, count = 1. Banner reappears 24h later.
//   - Second skip: skipped_at = now, count = 2. Banner stops showing.
//   - Beyond that: count > 2 keeps the banner gated off permanently. Founder
//     can still navigate to /assessment manually OR re-run from Settings.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const result = await resolveUser(req);
  if (!result.ok) return result.response;
  const { supabaseUserId } = result.user;

  const supabase = makeSupabaseServerClient();

  // Read current skip_count to increment. Two-query pattern (read-then-write)
  // is fine here — there's no concurrent skip path; founder physically can't
  // click Skip from two tabs faster than one query round-trip.
  const { data: row, error: readErr } = await supabase
    .from("users")
    .select("mh_assessment_skip_count")
    .eq("id", supabaseUserId)
    .single();
  if (readErr || !row) {
    console.error("[mh/assessment/skip] read failed", {
      supabaseUserId,
      message: readErr?.message ?? "no row",
    });
    return NextResponse.json(
      { ok: false, error: "read_failed" },
      { status: 500 },
    );
  }

  const nextCount = (row.mh_assessment_skip_count ?? 0) + 1;
  const { error: updErr } = await supabase
    .from("users")
    .update({
      mh_assessment_skipped_at: new Date().toISOString(),
      mh_assessment_skip_count: nextCount,
    })
    .eq("id", supabaseUserId);
  if (updErr) {
    console.error("[mh/assessment/skip] update failed", {
      supabaseUserId,
      message: updErr.message,
    });
    return NextResponse.json(
      { ok: false, error: "write_failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, skipCount: nextCount });
}
