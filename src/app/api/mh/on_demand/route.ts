import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import {
  composeOnDemand,
  frameworkUsedFor,
  validateOnDemand,
  type HelpRoute,
} from "@/lib/mh/helpMeThink";
import type { StorageTier } from "@/lib/mh/ritual";
import type { MhStyle } from "@/lib/supabase/hooks";

// POST /api/mh/on_demand
//
// Body: { route: 'decision' | 'inquiry' | 'drained' | 'other', raw: {...} }
// Returns: { ok: true, sessionId } on success
//          { ok: false, error: <code> } on validation / DB failure
//
// One-shot persist: each on-demand session is its own row in mh_sessions
// (type='on_demand'). No UPSERT semantics — re-clicking "Help me think"
// starts a fresh session. framework_used per the route → variant mapping
// in helpMeThink.ts (fixed for 3 routes; chat takes user's style).
//
// Tier read: server pulls mh_storage_tier from users every POST (same
// pattern as /api/mh/ritual — never trust client-passed tier).

export const runtime = "nodejs";

type RequestBody = { route?: unknown; raw?: unknown };

const VALID_ROUTES: HelpRoute[] = ["decision", "inquiry", "drained", "other"];

export async function POST(req: NextRequest) {
  const result = await resolveUser(req);
  if (!result.ok) return result.response;
  const { supabaseUserId } = result.user;

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "bad_request" },
      { status: 400 },
    );
  }

  if (
    typeof body.route !== "string" ||
    !VALID_ROUTES.includes(body.route as HelpRoute)
  ) {
    return NextResponse.json(
      { ok: false, error: "invalid_route" },
      { status: 400 },
    );
  }
  const route = body.route as HelpRoute;

  const validated = validateOnDemand(route, body.raw);
  if (!validated.ok) {
    return NextResponse.json(
      { ok: false, error: validated.error },
      { status: 400 },
    );
  }

  const supabase = makeSupabaseServerClient();
  const { data: userRow, error: userErr } = await supabase
    .from("users")
    .select("mh_style, mh_storage_tier")
    .eq("id", supabaseUserId)
    .single();
  if (userErr || !userRow) {
    console.error("[mh/on_demand] user lookup failed", {
      supabaseUserId,
      message: userErr?.message ?? "not_found",
    });
    return NextResponse.json(
      { ok: false, error: "user_lookup_failed" },
      { status: 500 },
    );
  }

  const tier = userRow.mh_storage_tier as StorageTier;
  const framework_used = frameworkUsedFor(
    route,
    userRow.mh_style as MhStyle | null,
  );
  const payload = composeOnDemand(tier, route, validated.cleaned);

  const { data: inserted, error: insErr } = await supabase
    .from("mh_sessions")
    .insert({
      user_id: supabaseUserId,
      type: "on_demand",
      framework_used,
      numeric_data: payload.numeric_data,
      text_data: payload.text_data,
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    console.error("[mh/on_demand] insert failed", {
      supabaseUserId,
      route,
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
    framework_used,
  });
}
