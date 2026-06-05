-- Handler #3 (classify-pending cron) primitives + schedule.
--
-- Mirrors 0006 + 0007 for fetch-bodies:
--   1. classify_claimed_at marker so concurrent firings don't double-claim.
--      Stale claims (>5 min) auto-reclaim on next firing.
--   2. public.claim_pending_classify_chunk(p_limit) — atomic SELECT FOR
--      UPDATE SKIP LOCKED + stamp claimed_at; returns rows. SECURITY DEFINER
--      because the cron route uses service_role.
--   3. cron.schedule('classify-pending', ...) — every minute, posts to
--      /api/cron/classify-pending with the cron_secret bearer.
--
-- After applying, run the verification queries below in the Supabase SQL
-- Editor and paste the outputs into the commit message body (per
-- CONVENTIONS.md "log the actual response shape" rule 4).
--
-- VERIFICATION QUERIES:
--   -- function exists
--   select proname, pg_get_function_result(oid) from pg_proc
--   where proname = 'claim_pending_classify_chunk'
--     and pronamespace = 'public'::regnamespace;
--
--   -- column exists
--   select column_name, data_type from information_schema.columns
--   where table_schema = 'public' and table_name = 'emails'
--     and column_name = 'classify_claimed_at';
--
--   -- cron scheduled
--   select jobname, schedule from cron.job where jobname = 'classify-pending';
--
--   -- pending count is dropping (run twice 2 min apart)
--   select count(*) from emails
--   where classification is null and status = 'pending' and archived_stale = false;
--
-- PREREQUISITES: cron_base_url and cron_secret rows must already exist in
-- private.config (set up by migration 0007's one-off setup). The schedule
-- below reuses both.

-- ============================================================================
-- 1. claim marker column + reclaim filter
-- ============================================================================
-- Nullable: NULL = unclaimed, populated = "a route is processing this row."
-- Same pattern as body_fetch_claimed_at from 0006.

alter table public.emails
  add column if not exists classify_claimed_at timestamptz;

-- ============================================================================
-- 2. atomic claim helper
-- ============================================================================
-- Selection rule: status='pending' AND classification IS NULL AND
-- archived_stale = false. The classifier only touches active-pool rows that
-- haven't been classified yet. archived_stale rows are pre-aged-out by the
-- ingest prune and shouldn't be picked up by a fresh-classify pass.
--
-- The CTE locks candidates with FOR UPDATE SKIP LOCKED so concurrent firings
-- see disjoint rows; the outer UPDATE stamps classify_claimed_at and returns
-- the columns the route needs (id, user_id, from_address, subject, snippet).
-- The route does a separate users lookup for the email — mirrors fetch-bodies
-- (which does its own users lookup for clerk_user_id).

create or replace function public.claim_pending_classify_chunk(
  p_limit int,
  p_stale_after interval default interval '5 minutes'
)
returns table (
  id uuid,
  user_id uuid,
  from_address text,
  subject text,
  snippet text
)
language sql
security definer
set search_path = public
as $$
  with candidates as (
    select id
    from public.emails
    where status = 'pending'
      and classification is null
      and archived_stale = false
      and (classify_claimed_at is null
           or classify_claimed_at < now() - p_stale_after)
    order by created_at asc
    limit p_limit
    for update skip locked
  )
  update public.emails e
  set classify_claimed_at = now()
  from candidates
  where e.id = candidates.id
  returning e.id, e.user_id, e.from_address, e.subject, e.snippet;
$$;

revoke all on function public.claim_pending_classify_chunk(int, interval) from public;
-- service_role bypasses the revoke so the route can still call it. No grant
-- to authenticated — this function is server-side only.

-- ============================================================================
-- 3. cron schedule
-- ============================================================================
-- Idempotent: unschedule if already present, then re-schedule.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'classify-pending') then
    perform cron.unschedule('classify-pending');
  end if;
end $$;

select cron.schedule(
  'classify-pending',
  '* * * * *',
  $cron$
    select net.http_post(
      url := (select private.get_secret('cron_base_url')) || '/api/cron/classify-pending',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || (select private.get_secret('cron_secret')),
        'Content-Type',
        'application/json'
      )
    )
  $cron$
);
