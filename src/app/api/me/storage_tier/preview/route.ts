import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import type { StorageTier } from "@/lib/mh/ritual";

// GET /api/me/storage_tier/preview?newTier=N
//
// Returns the deletion preview for a hypothetical tier change. No mutation.
// Used by the Settings confirmation modal to populate the "this will
// delete X past entries" disclosure before the user types DOWNGRADE.
//
// Logic per Tab 2 00:50 UTC Sharp Q2 lock:
//   - text_data nulled if currentTier >= 3 AND newTier < 3
//   - numeric_data nulled if currentTier >= 2 AND newTier < 2
//   - correlations deleted if currentTier === 4 AND newTier < 4

export const runtime = "nodejs";

const VALID_TIERS: StorageTier[] = [1, 2, 3, 4];

export async function GET(req: NextRequest) {
  const result = await resolveUser(req);
  if (!result.ok) return result.response;
  const { supabaseUserId } = result.user;

  const newTierParam = req.nextUrl.searchParams.get("newTier");
  const newTier = newTierParam ? Number(newTierParam) : NaN;
  if (!VALID_TIERS.includes(newTier as StorageTier)) {
    return NextResponse.json({ error: "invalid_new_tier" }, { status: 400 });
  }
  const target = newTier as StorageTier;

  const supabase = makeSupabaseServerClient();
  const { data: userRow, error: userErr } = await supabase
    .from("users")
    .select("mh_storage_tier")
    .eq("id", supabaseUserId)
    .single();
  if (userErr || !userRow) {
    return NextResponse.json(
      { error: "user_lookup_failed" },
      { status: 500 },
    );
  }
  const currentTier = userRow.mh_storage_tier as StorageTier;

  // Default counts = 0 (no-op for same-tier or upgrade preview).
  let textToBeNulled = 0;
  let numericToBeNulled = 0;
  let correlationsToBeDeleted = 0;

  if (currentTier >= 3 && target < 3) {
    const { count } = await supabase
      .from("mh_sessions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", supabaseUserId)
      .not("text_data", "is", null);
    textToBeNulled = count ?? 0;
  }
  if (currentTier >= 2 && target < 2) {
    const { count } = await supabase
      .from("mh_sessions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", supabaseUserId)
      .not("numeric_data", "is", null);
    numericToBeNulled = count ?? 0;
  }
  if (currentTier === 4 && target < 4) {
    const { count } = await supabase
      .from("mh_correlations")
      .select("id", { count: "exact", head: true })
      .eq("user_id", supabaseUserId);
    correlationsToBeDeleted = count ?? 0;
  }

  return NextResponse.json({
    currentTier,
    newTier: target,
    isDowngrade: target < currentTier,
    textToBeNulled,
    numericToBeNulled,
    correlationsToBeDeleted,
  });
}
