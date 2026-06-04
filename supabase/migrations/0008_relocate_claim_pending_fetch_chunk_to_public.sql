-- Relocate claim_pending_fetch_chunk from private schema to public.
--
-- Why: migration 0006 placed the function in `private`, but the cron route
-- calls it via supabase.rpc('claim_pending_fetch_chunk') — supabase-js routes
-- bare .rpc() through `public` by default. The mismatch caused every cron
-- firing to fail with "Could not find the function public.claim_pending_
-- fetch_chunk" until a public-schema clone was created ad-hoc on 2026-06-04.
--
-- Two options were on the table:
--   (a) Standardize on public, drop the private original. ← picked.
--   (b) Keep private, switch route to supabase.schema('private').rpc(), and
--       expose the private schema via PostgREST.
--
-- Option (a) wins because security is enforced by REVOKE ALL FROM PUBLIC +
-- SECURITY DEFINER + service_role-only invocation — the schema name carries
-- no protection, only convention. Exposing `private` via PostgREST would
-- defeat the "internal" intent of the schema anyway. See CONVENTIONS.md
-- "Schema split for SQL functions" for the rule going forward.
--
-- Note: private.get_secret() stays in private because it's invoked from
-- inside pg_cron SQL bodies (select private.get_secret('cron_secret')), not
-- via supabase-js .rpc() from app code. That doesn't go through PostgREST.

-- ============================================================================
-- 1. Codify the public-schema function
-- ============================================================================
-- Same body as the original 0006 definition; just relocated. Idempotent via
-- CREATE OR REPLACE so re-applying this migration (or applying it after the
-- 2026-06-04 ad-hoc creation) is safe.

create or replace function public.claim_pending_fetch_chunk(
  p_limit int,
  p_stale_after interval default interval '5 minutes'
)
returns table (
  id uuid,
  user_id uuid,
  gmail_message_id text,
  thread_id text
)
language sql
security definer
set search_path = public
as $$
  with candidates as (
    select id
    from public.emails
    where status = 'pending_fetch'
      and (body_fetch_claimed_at is null
           or body_fetch_claimed_at < now() - p_stale_after)
    order by created_at asc
    limit p_limit
    for update skip locked
  )
  update public.emails e
  set body_fetch_claimed_at = now()
  from candidates
  where e.id = candidates.id
  returning e.id, e.user_id, e.gmail_message_id, e.thread_id;
$$;

revoke all on function public.claim_pending_fetch_chunk(int, interval) from public;
-- service_role bypasses the REVOKE so the route can still call it. anon /
-- authenticated cannot reach this function via PostgREST.

-- ============================================================================
-- 2. Drop the orphaned private original
-- ============================================================================
-- Cron has been calling the public clone since 2026-06-04. The private
-- original has zero call sites left.

drop function if exists private.claim_pending_fetch_chunk(int, interval);
