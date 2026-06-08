import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import { validateRankings, scoreRankings } from "@/lib/mh/assessment";

// POST /api/mh/assessment
//
// Body: { rankings: [{ questionId, ranks: [{ framework, rank }, ...] }, ...] }
// Returns: { ok: true, mhStyle, scores, tieBreakUsed } on success
//          { ok: false, error: <code> } on validation failure
//
// Scoring runs server-side — we never trust the client to compute the
// mh_style result. Writes both `users.mh_style` and clears the skip state
// (skipped_at = null, skip_count keeps history but is no longer used by
// the banner since mh_style IS NOT NULL gates it off).

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const result = await resolveUser(req);
  if (!result.ok) return result.response;
  const { supabaseUserId } = result.user;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "bad_request" },
      { status: 400 },
    );
  }

  const validated = validateRankings(raw);
  if (!validated.ok) {
    return NextResponse.json(
      { ok: false, error: validated.error },
      { status: 400 },
    );
  }

  const scored = scoreRankings(validated.rankings);

  const supabase = makeSupabaseServerClient();
  const { error: updErr } = await supabase
    .from("users")
    .update({
      mh_style: scored.mhStyle,
      mh_assessment_skipped_at: null,
    })
    .eq("id", supabaseUserId);
  if (updErr) {
    console.error("[mh/assessment] update failed", {
      supabaseUserId,
      mhStyle: scored.mhStyle,
      message: updErr.message,
    });
    return NextResponse.json(
      { ok: false, error: "write_failed" },
      { status: 500 },
    );
  }

  console.log("[mh/assessment] result", {
    supabaseUserId,
    mhStyle: scored.mhStyle,
    scores: scored.scores,
    tieBreakUsed: scored.tieBreakUsed,
  });

  return NextResponse.json({
    ok: true,
    mhStyle: scored.mhStyle,
    scores: scored.scores,
    tieBreakUsed: scored.tieBreakUsed,
  });
}
