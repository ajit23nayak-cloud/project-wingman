-- Handler #2 (body-fetch cron) primitives:
--   1. body_fetch_claimed_at — marker so concurrent firings don't double-claim
--      pending_fetch rows. Stale claim (>5 min) auto-reclaims on next firing.
--   2. private.claim_pending_fetch_chunk(p_limit) — atomic SELECT FOR UPDATE
--      SKIP LOCKED + UPDATE-set-claimed_at, returns claimed rows. Race window
--      between claim and metadata write is bound by Vercel's 10s ceiling.
--   3. cron_runs table — one row per cron firing, per-user-batch outcome
--      (success, token failure, partial fail). Drives cron_recent_failures
--      view that the morning routine reads.
--   4. cron_recent_failures view — failed firings in last 24h, sorted newest
--      first. Empty result = healthy.
--
-- Apply via Supabase dashboard → SQL Editor → Run.

-- ============================================================================
-- 1. claim marker column + reclaim filter
-- ============================================================================
-- Nullable: NULL = unclaimed, populated = "a route is processing this row."
-- We don't reset to NULL on success — the row's status changes to 'pending'
-- or 'failed' which already excludes it from the queue.

alter table emails add column body_fetch_claimed_at timestamptz;

-- ============================================================================
-- 2. atomic claim helper
-- ============================================================================
-- The CTE locks the candidate rows via FOR UPDATE SKIP LOCKED (so concurrent
-- claims see different rows), then the outer UPDATE stamps body_fetch_claimed
-- _at = now() and returns the rows. Both happen in a single statement so the
-- lock-and-stamp is atomic from any caller's perspective.
--
-- p_stale_after gives the route a configurable grace period. Rows claimed
-- more than p_stale_after ago count as orphaned (likely a route that timed
-- out before issuing the success UPDATE) and are re-claimable.

create or replace function private.claim_pending_fetch_chunk(
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

revoke all on function private.claim_pending_fetch_chunk(int, interval) from public;
-- service_role bypasses revocations so the route can still call it. No grant
-- to authenticated — this function is server-side only.

-- ============================================================================
-- 3. cron_runs observability table
-- ============================================================================
-- One row per cron firing per user batch (or one row per "empty queue" /
-- "claim failed" outcome). Stage values are free text but conventions:
--   'claim'    — claim_pending_fetch_chunk outcome
--   'token'    — Clerk OAuth token fetch outcome
--   'fetch'    — Gmail messages.get outcome
--   'write'    — emails UPDATE outcome
--   'complete' — end-of-firing summary (rolls up the above)
--
-- error_code values are stable strings the cron_recent_failures view groups
-- on (e.g. 'no_google_token', 'gmail_404', 'gmail_rate_limit', 'db_write').

create table cron_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  ran_at timestamptz not null default now(),
  ok boolean not null,
  user_id uuid references users(id) on delete set null,
  stage text,
  error_code text,
  detail text
);

create index cron_runs_by_ran_at on cron_runs (ran_at desc);
create index cron_runs_failed_recent on cron_runs (ran_at desc) where ok = false;

alter table cron_runs enable row level security;
-- No policies → default deny for both anon and authenticated. Only the
-- service_role key can read or write this table, which means access only
-- through server routes (e.g. an admin diagnostics endpoint).

-- ============================================================================
-- 4. cron_recent_failures view
-- ============================================================================
-- Morning-routine query: select * from cron_recent_failures. Empty = healthy.
-- 24-hour window matches the lookback for "is anything broken right now?"
-- For older incidents, query cron_runs directly.

create or replace view cron_recent_failures as
select id, job_name, ran_at, user_id, stage, error_code, detail
from cron_runs
where ok = false
  and ran_at > now() - interval '24 hours'
order by ran_at desc;

-- The view inherits cron_runs' RLS (default deny). Admin reads via
-- service_role server route.
