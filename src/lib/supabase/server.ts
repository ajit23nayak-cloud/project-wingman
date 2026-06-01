// Server-side Supabase client. Uses SUPABASE_SERVICE_ROLE_KEY which BYPASSES
// every RLS policy. Use only inside Vercel API routes / server actions doing
// internal work (ingest, classify, cron). Two rules:
//   1. Never expose this client or the service-role key to the browser.
//   2. When acting on behalf of a user, filter by user_id explicitly in the
//      query — service_role has no auth.jwt() context, so RLS won't save you.

import "server-only";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

export function makeSupabaseServerClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
