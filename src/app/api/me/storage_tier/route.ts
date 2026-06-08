import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import type { StorageTier } from "@/lib/mh/ritual";

// POST /api/me/storage_tier
//
// Body: { newTier: 1 | 2 | 3 | 4 }
// Returns: { ok: true, newTier, cleanupApplied: { textNulled, numericNulled, correlationsDeleted } }
//          { ok: false, error: <code> } on failure
//
// Locked per Tab 2 00:50 UTC:
//   Upgrade (newTier > current): just UPDATE users.mh_storage_tier. No
//     cleanup, no backfill of past sessions (Flag A).
//   Downgrade (newTier < current): run cleanup cascade THEN UPDATE tier.
//     UPDATE-set-null on mh_sessions preserves the row (timestamps +
//     framework_used + type) which is still tier-1-acceptable. DELETE on
//     mh_correlations because tier 4 is the only tier that has them.
//   Same tier: no-op, 200 ok.
//
// Flag E race acceptance: a write from another tab between cleanup and
// UPDATE could leave a stale row. Acceptable for single-user trial; v1
// adds tier-stamped writes for race safety.

export const runtime = "nodejs";

const VALID_TIERS: StorageTier[] = [1, 2, 3, 4];

type RequestBody = { newTier?: unknown };

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
    typeof body.newTier !== "number" ||
    !VALID_TIERS.includes(body.newTier as StorageTier)
  ) {
    return NextResponse.json(
      { ok: false, error: "invalid_new_tier" },
      { status: 400 },
    );
  }
  const newTier = body.newTier as StorageTier;

  const supabase = makeSupabaseServerClient();
  const { data: userRow, error: userErr } = await supabase
    .from("users")
    .select("mh_storage_tier")
    .eq("id", supabaseUserId)
    .single();
  if (userErr || !userRow) {
    return NextResponse.json(
      { ok: false, error: "user_lookup_failed" },
      { status: 500 },
    );
  }
  const currentTier = userRow.mh_storage_tier as StorageTier;

  if (newTier === currentTier) {
    return NextResponse.json({
      ok: true,
      newTier,
      cleanupApplied: {
        textNulled: 0,
        numericNulled: 0,
        correlationsDeleted: 0,
      },
    });
  }

  let textNulled = 0;
  let numericNulled = 0;
  let correlationsDeleted = 0;

  // Downgrade cascade: run highest-tier cleanups first so a mid-cascade
  // failure leaves the user at the original tier with partial cleanup
  // rather than at the new tier with stale higher-tier data.
  if (newTier < currentTier) {
    if (currentTier === 4 && newTier < 4) {
      const { error, count } = await supabase
        .from("mh_correlations")
        .delete({ count: "exact" })
        .eq("user_id", supabaseUserId);
      if (error) {
        console.error("[storage_tier] correlations delete failed", {
          supabaseUserId,
          message: error.message,
        });
        return NextResponse.json(
          { ok: false, error: "correlations_delete_failed" },
          { status: 500 },
        );
      }
      correlationsDeleted = count ?? 0;
    }

    if (currentTier >= 3 && newTier < 3) {
      const { error, count } = await supabase
        .from("mh_sessions")
        .update({ text_data: null }, { count: "exact" })
        .eq("user_id", supabaseUserId)
        .not("text_data", "is", null);
      if (error) {
        console.error("[storage_tier] text_data null failed", {
          supabaseUserId,
          message: error.message,
        });
        return NextResponse.json(
          { ok: false, error: "text_null_failed" },
          { status: 500 },
        );
      }
      textNulled = count ?? 0;
    }

    if (currentTier >= 2 && newTier < 2) {
      const { error, count } = await supabase
        .from("mh_sessions")
        .update({ numeric_data: null }, { count: "exact" })
        .eq("user_id", supabaseUserId)
        .not("numeric_data", "is", null);
      if (error) {
        console.error("[storage_tier] numeric_data null failed", {
          supabaseUserId,
          message: error.message,
        });
        return NextResponse.json(
          { ok: false, error: "numeric_null_failed" },
          { status: 500 },
        );
      }
      numericNulled = count ?? 0;
    }
  }

  // Finally update the tier itself.
  const { error: tierUpdErr } = await supabase
    .from("users")
    .update({ mh_storage_tier: newTier })
    .eq("id", supabaseUserId);
  if (tierUpdErr) {
    console.error("[storage_tier] tier update failed (cleanup already ran)", {
      supabaseUserId,
      newTier,
      message: tierUpdErr.message,
    });
    return NextResponse.json(
      { ok: false, error: "tier_update_failed" },
      { status: 500 },
    );
  }

  console.log("[storage_tier] tier change applied", {
    supabaseUserId,
    fromTier: currentTier,
    toTier: newTier,
    textNulled,
    numericNulled,
    correlationsDeleted,
  });

  return NextResponse.json({
    ok: true,
    newTier,
    cleanupApplied: { textNulled, numericNulled, correlationsDeleted },
  });
}
