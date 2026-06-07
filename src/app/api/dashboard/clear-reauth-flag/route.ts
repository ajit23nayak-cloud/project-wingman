import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import { clearGmailReauthFlag } from "@/lib/auth/gmailReauth";

// POST /api/dashboard/clear-reauth-flag
//
// Fired from the /account page's "Done" button after the founder reconnects
// Gmail via Clerk's <UserProfile> Connected Accounts portal. Clears the
// gmail_reauth_needed flag so the dashboard banner disappears on next
// useMe revalidation.
//
// This is strategy (i) of the two-strategy clearing model. Strategy (ii) is
// the auto-clear in the success paths of /api/ingest-emails and
// /api/cron/fetch-bodies, which self-heals out-of-band reconnects (e.g.
// user revokes + re-authorizes via google.com/permissions without using
// the banner).

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const result = await resolveUser(req);
  if (!result.ok) return result.response;

  const { supabaseUserId } = result.user;
  const supabase = makeSupabaseServerClient();
  await clearGmailReauthFlag(supabase, supabaseUserId);

  return NextResponse.json({ ok: true });
}
