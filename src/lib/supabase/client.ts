// Browser-side Supabase client. Uses the anon key plus the user's Clerk JWT
// (template name "supabase") so every request lands at Postgres with the user
// scoped by RLS. NEVER import this from a server file — pair with the
// service-role client in ./server.ts instead.

import { createClient, SupabaseClient } from "@supabase/supabase-js";

export function makeSupabaseBrowserClient(
  getClerkToken: () => Promise<string | null>,
): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: async (input, init = {}) => {
          const token = await getClerkToken();
          const headers = new Headers(init.headers);
          if (token) headers.set("Authorization", `Bearer ${token}`);
          return fetch(input, { ...init, headers });
        },
      },
    },
  );
}

export function makeSupabaseAnonClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
