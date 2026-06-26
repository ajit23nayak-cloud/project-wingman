import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// POST /api/reflection
//
// User-submitted evening reflection. Writes to daily_reflections
// (migration 0025 — unique(user_id, reflection_date) so per-day upsert
// just works via on_conflict). Both good_today + carry_tomorrow are
// nullable text.
//
// Schema mapping decision: spec said "rough/steady/great quick-select +
// free-text input." The existing columns are good_today + carry_tomorrow.
// Mapping: tone → good_today (one of "rough"|"steady"|"great"|null),
// free_text → carry_tomorrow. Both nullable, so empty submissions are
// rejected at the route layer (need at least one).

export const runtime = "nodejs";

type ReflectionBody = {
  tone?: "rough" | "steady" | "great" | null;
  free_text?: string | null;
};

export async function POST(req: NextRequest) {
  const resolved = await resolveUser(req);
  if (!resolved.ok) return resolved.response;
  const { supabaseUserId } = resolved.user;

  let body: ReflectionBody;
  try {
    body = (await req.json()) as ReflectionBody;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const tone =
    body.tone === "rough" || body.tone === "steady" || body.tone === "great"
      ? body.tone
      : null;
  const freeText =
    typeof body.free_text === "string" && body.free_text.trim().length > 0
      ? body.free_text.trim().slice(0, 1000)
      : null;

  if (!tone && !freeText) {
    return NextResponse.json(
      { ok: false, error: "empty_reflection" },
      { status: 400 },
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const supabase = makeSupabaseServerClient();
  const { error } = await supabase
    .from("daily_reflections")
    .upsert(
      {
        user_id: supabaseUserId,
        reflection_date: today,
        good_today: tone,
        carry_tomorrow: freeText,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,reflection_date" },
    );

  if (error) {
    console.error("[reflection] upsert failed", {
      supabaseUserId,
      message: error.message,
    });
    return NextResponse.json(
      { ok: false, error: "upsert_failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
