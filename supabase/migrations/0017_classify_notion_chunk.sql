-- Handler #3.6 (classify-pending cron — Notion queue) primitive.
--
-- Companion to 0010 (emails) and 0015 (Slack). The existing classify-pending
-- cron route processes queues per firing in order: emails → Slack → Notion
-- (per Tab 2 architectural lock for Phase 2a). That means we ONLY need a
-- parallel claim RPC here — no new cron schedule, no new claim column, no
-- new partial index.
--
-- Prereqs already in place from migration 0016 (Notion foundation):
--   - public.notion_pages.classify_claimed_at timestamptz column
--   - partial index notion_pages_pending_classify on (integration_id, status)
--     where status='pending'
--   - status text check (pending/processed/failed) + classification text check
--
-- This migration adds the single missing piece: the atomic claim RPC that
-- mirrors public.claim_pending_classify_slack_chunk. Same SELECT FOR UPDATE
-- SKIP LOCKED pattern, same 5-minute stale-claim auto-reclaim, same
-- SECURITY DEFINER so the cron route's service_role can invoke it.
--
-- After applying, run the verification queries below in the Supabase SQL
-- Editor and paste the outputs into the commit body (per CONVENTIONS.md
-- "log the actual response shape" rule 4).
--
-- VERIFICATION QUERIES:
--   -- function exists with the right return shape
--   select proname, pg_get_function_result(oid) from pg_proc
--   where proname = 'claim_pending_classify_notion_chunk'
--     and pronamespace = 'public'::regnamespace;
--
--   -- service_role can execute, anon/authenticated cannot
--   select has_function_privilege('anon', 'public.claim_pending_classify_notion_chunk(int, interval)', 'EXECUTE'),
--          has_function_privilege('authenticated', 'public.claim_pending_classify_notion_chunk(int, interval)', 'EXECUTE'),
--          has_function_privilege('service_role', 'public.claim_pending_classify_notion_chunk(int, interval)', 'EXECUTE');
--
--   -- queue drain check (run twice 2 min apart after Notion ingest)
--   select count(*) from notion_pages
--   where status = 'pending' and classification is null and archived_stale = false;

-- ============================================================================
-- atomic claim helper for Notion pages
-- ============================================================================
-- Selection rule: status='pending' AND classification IS NULL AND
-- archived_stale = false. Same predicate shape as the emails/slack RPCs.
--
-- The CTE locks candidates with FOR UPDATE SKIP LOCKED so concurrent firings
-- see disjoint rows; the outer UPDATE stamps classify_claimed_at and returns
-- the columns the route needs to build the Notion-source prompt (title,
-- snippet, last_edited_at, page_id) + the integration_id for grouping and
-- user_id for the founder-email lookup.

create or replace function public.claim_pending_classify_notion_chunk(
  p_limit int,
  p_stale_after interval default interval '5 minutes'
)
returns table (
  id uuid,
  user_id uuid,
  integration_id uuid,
  page_id text,
  title text,
  snippet text,
  last_edited_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  with candidates as (
    select id
    from public.notion_pages
    where status = 'pending'
      and classification is null
      and archived_stale = false
      and (classify_claimed_at is null
           or classify_claimed_at < now() - p_stale_after)
    order by created_at asc
    limit p_limit
    for update skip locked
  )
  update public.notion_pages p
  set classify_claimed_at = now()
  from candidates
  where p.id = candidates.id
  returning p.id, p.user_id, p.integration_id, p.page_id, p.title,
            p.snippet, p.last_edited_at;
$$;

revoke all on function public.claim_pending_classify_notion_chunk(int, interval) from public;
-- service_role bypasses the revoke so the route can still call it. No grant
-- to authenticated — this function is server-side only.
