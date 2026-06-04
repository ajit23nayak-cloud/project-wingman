-- Public RPC for the dashboard's filter-chip counts. Returns a single row
-- with the 5 filter-bucket counts + the "still classifying" pending count,
-- so the dashboard makes one round-trip on mount instead of 6 separate
-- count() queries.
--
-- SECURITY INVOKER: function runs as the calling role, NOT the function
-- owner. Combined with the existing emails RLS policy (user_id =
-- private.requesting_user_id()), this means an authenticated caller sees
-- counts for their rows only, never anyone else's. Per CONVENTIONS.md the
-- function lives in `public` because the dashboard browser client calls it
-- via supabase.rpc('email_counts'). authenticated grant lets the Clerk-JWT'd
-- browser client invoke it.
--
-- archived_stale filter mirrors the dashboard's main list: aged-out rows
-- aren't in the active pool, so they don't contribute to any chip count.

create or replace function public.email_counts()
returns table (
  total int,
  urgent int,
  important int,
  fyi int,
  archive int,
  failed int,
  pending int
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*)::int as total,
    count(*) filter (where classification = 'urgent')::int as urgent,
    count(*) filter (where classification = 'important')::int as important,
    count(*) filter (where classification = 'fyi')::int as fyi,
    count(*) filter (where classification = 'archive')::int as archive,
    count(*) filter (where status = 'failed')::int as failed,
    count(*) filter (where classification is null and status = 'pending')::int as pending
  from public.emails
  where archived_stale = false;
$$;

grant execute on function public.email_counts() to authenticated;
