import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import {
  composePayload,
  validateRaw,
  variantFor,
  type RitualType,
  type RitualVariant,
  type StorageTier,
} from "@/lib/mh/ritual";

// POST /api/mh/ritual
//
// Body: { type: 'morning_ritual' | 'evening_ritual', raw: { fieldKey: value, ... } }
// Returns: { ok: true, sessionId, framework_used } on success
//          { ok: false, error: <code> } on validation failure
//
// UPSERT pattern (Tab 2 19:10 UTC lock flag A): SELECT today's row for
// (user_id, type, today). If exists, UPDATE. If not, INSERT. No new
// migration — app-layer enforcement of one-row-per-day-per-type.
//
// Tier read pattern (Tab 2 19:10 UTC lock note): server reads mh_storage_tier
// from users row on every POST. Don't trust a client-passed tier — that
// would let a tier 2 client claim tier 3 to leak text into their numeric-
// only row. Same guard as assessment scoring.

export const runtime = "nodejs";

type RequestBody = { type?: unknown; raw?: unknown };

function dayBoundsUtc(date: Date): { start: string; end: string } {
  const start = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

export async function POST(req: NextRequest) {
  const result = await resolveUser(req);
  if (!result.ok) return result.response;
  const { supabaseUserId } = result.user;

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  if (body.type !== "morning_ritual" && body.type !== "evening_ritual") {
    return NextResponse.json(
      { ok: false, error: "invalid_type" },
      { status: 400 },
    );
  }
  const ritualType = body.type as RitualType;

  const supabase = makeSupabaseServerClient();

  // Server reads user's mh_style + tier — never trust the client.
  const { data: userRow, error: userErr } = await supabase
    .from("users")
    .select("mh_style, mh_storage_tier")
    .eq("id", supabaseUserId)
    .single();
  if (userErr || !userRow) {
    console.error("[mh/ritual] user lookup failed", {
      supabaseUserId,
      message: userErr?.message ?? "not_found",
    });
    return NextResponse.json(
      { ok: false, error: "user_lookup_failed" },
      { status: 500 },
    );
  }

  const variant: RitualVariant = variantFor(
    userRow.mh_style as "operational" | "state" | "inquiry" | null,
  );
  const tier = userRow.mh_storage_tier as StorageTier;

  // Validate raw fields against the variant's field shape.
  const validated = validateRaw(variant, ritualType, body);
  if (!validated.ok) {
    return NextResponse.json(
      { ok: false, error: validated.error },
      { status: 400 },
    );
  }

  const payload = composePayload(tier, variant, ritualType, validated.raw);

  // UPSERT for today. Two-query pattern: SELECT then UPDATE or INSERT. No
  // DB-level UNIQUE constraint per the spec lock — app layer is enough for
  // single-user-per-tab flow.
  const today = dayBoundsUtc(new Date());
  const { data: existing, error: existErr } = await supabase
    .from("mh_sessions")
    .select("id")
    .eq("user_id", supabaseUserId)
    .eq("type", ritualType)
    .gte("created_at", today.start)
    .lt("created_at", today.end)
    .maybeSingle();
  if (existErr) {
    console.error("[mh/ritual] today lookup failed", {
      supabaseUserId,
      ritualType,
      message: existErr.message,
    });
    return NextResponse.json(
      { ok: false, error: "today_lookup_failed" },
      { status: 500 },
    );
  }

  if (existing) {
    const { error: updErr } = await supabase
      .from("mh_sessions")
      .update({
        framework_used: variant,
        numeric_data: payload.numeric_data,
        text_data: payload.text_data,
      })
      .eq("id", existing.id);
    if (updErr) {
      console.error("[mh/ritual] update failed", {
        supabaseUserId,
        sessionId: existing.id,
        message: updErr.message,
      });
      return NextResponse.json(
        { ok: false, error: "update_failed" },
        { status: 500 },
      );
    }
    return NextResponse.json({
      ok: true,
      sessionId: existing.id,
      framework_used: variant,
      updated: true,
    });
  }

  const { data: inserted, error: insErr } = await supabase
    .from("mh_sessions")
    .insert({
      user_id: supabaseUserId,
      type: ritualType,
      framework_used: variant,
      numeric_data: payload.numeric_data,
      text_data: payload.text_data,
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    console.error("[mh/ritual] insert failed", {
      supabaseUserId,
      ritualType,
      message: insErr?.message ?? "no row",
    });
    return NextResponse.json(
      { ok: false, error: "insert_failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    sessionId: inserted.id,
    framework_used: variant,
    updated: false,
  });
}
