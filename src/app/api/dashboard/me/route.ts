import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// GET /api/dashboard/me
//
// Auth-required identity endpoint for the browser dashboard. resolveUser()
// handles Clerk session → Supabase users row mapping and auto-creates the
// row on first hit, so this endpoint doubles as the "ensure I have an
// account" handshake the dashboard fires on mount.
//
// We piggyback a one-field read on top — lastIngestedAt — so the dashboard
// can show "last sync: X minutes ago" without a second round-trip.

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const result = await resolveUser(req);
  if (!result.ok) return result.response;

  const { supabaseUserId, email } = result.user;
  const supabase = makeSupabaseServerClient();
  const { data: row, error } = await supabase
    .from("users")
    .select(
      "last_ingested_at, gmail_reauth_needed, gmail_reauth_needed_at, mh_style, mh_storage_tier, mh_assessment_skipped_at, mh_assessment_skip_count, timezone",
    )
    .eq("id", supabaseUserId)
    .single();
  // Log but don't fail the request — a missing read just falls back to null,
  // which the dashboard treats as "brand-new user, auto-trigger first ingest."
  // Without the log we can't distinguish a real DB error from that path.
  if (error) {
    console.error("[dashboard/me] users select failed", {
      supabaseUserId,
      message: error.message,
    });
  }

  return NextResponse.json({
    supabaseUserId,
    email,
    lastIngestedAt: row?.last_ingested_at ?? null,
    gmailReauthNeeded: row?.gmail_reauth_needed ?? false,
    gmailReauthNeededAt: row?.gmail_reauth_needed_at ?? null,
    mhStyle: row?.mh_style ?? null,
    mhStorageTier: row?.mh_storage_tier ?? 2,
    mhAssessmentSkippedAt: row?.mh_assessment_skipped_at ?? null,
    mhAssessmentSkipCount: row?.mh_assessment_skip_count ?? 0,
    timezone: row?.timezone ?? "Asia/Kolkata",
  });
}
