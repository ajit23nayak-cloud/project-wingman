// Server-only helpers for the gmail_reauth_needed flag on public.users.
//
// markGmailReauthNeeded: called from route catch blocks when Clerk's OAuth
// grant for Google has failed (token fetch threw, no token returned, or a
// mid-call gmail.* 401/invalid_grant fired). Idempotent — re-setting on an
// already-flagged row is a no-op write.
//
// clearGmailReauthFlag: called in two places per the architecture lock:
//   (i)  /api/dashboard/clear-reauth-flag (user clicked Done after reconnect)
//   (ii) success paths of ingest-emails + fetch-bodies (self-heal on next
//        successful gmail.* call). The two paths cover both Wingman-driven
//        reconnects and out-of-band reconnects via google.com/permissions.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function markGmailReauthNeeded(
  supabase: SupabaseClient,
  supabaseUserId: string,
): Promise<void> {
  const { error } = await supabase
    .from("users")
    .update({
      gmail_reauth_needed: true,
      gmail_reauth_needed_at: new Date().toISOString(),
    })
    .eq("id", supabaseUserId);
  if (error) {
    console.error("[gmailReauth:mark] update failed", {
      supabaseUserId,
      message: error.message,
    });
  }
}

export async function clearGmailReauthFlag(
  supabase: SupabaseClient,
  supabaseUserId: string,
): Promise<void> {
  const { error } = await supabase
    .from("users")
    .update({
      gmail_reauth_needed: false,
      gmail_reauth_needed_at: null,
    })
    .eq("id", supabaseUserId);
  if (error) {
    console.error("[gmailReauth:clear] update failed", {
      supabaseUserId,
      message: error.message,
    });
  }
}
