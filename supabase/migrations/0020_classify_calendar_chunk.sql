-- Handler #3.7 (classify-pending cron — Calendar queue) primitive.
--
-- Companion to 0010 (emails), 0015 (Slack), and 0017 (Notion). The existing
-- classify-pending cron route processes queues per firing in order: emails →
-- Slack → Notion → Calendar (per Tab 2 architectural lock for Phase 2b).
-- That means we ONLY need a parallel claim RPC here — no new cron schedule,
-- no new claim column, no new partial index.
--
-- Prereqs already in place from migration 0019 (Calendar foundation):
--   - public.calendar_events.classify_claimed_at timestamptz column
--   - partial index calendar_events_pending_classify on (user_id, status)
--     where status='pending'
--   - status text check (pending/processed/failed) + prep_priority text check
--
-- This migration adds the single missing piece: the atomic claim RPC that
-- mirrors public.claim_pending_classify_notion_chunk. Same SELECT FOR UPDATE
-- SKIP LOCKED pattern, same 5-minute stale-claim auto-reclaim, same
-- SECURITY DEFINER so the cron route's service_role can invoke it.
--
-- IMPORTANT DIFFERENCE from the other three RPCs:
--   The "already-classified" predicate is `prep_priority IS NULL`, not
--   `classification IS NULL`. Calendar uses a different output column
--   (prep_priority — "do I need to prep" — instead of classification —
--   "urgent/important/fyi/archive") because the meaning of the classifier
--   output is different for meetings vs messages. Agent B wires the route
--   to read this column for the "already done" check.
--
-- After applying, run the verification queries below in the Supabase SQL
-- Editor and paste the outputs into the commit body (per CONVENTIONS.md
-- "log the actual response shape" rule 4).
--
-- VERIFICATION QUERIES:
--   -- function exists with the right return shape
--   select proname, pg_get_function_result(oid) from pg_proc
--   where proname = 'claim_pending_classify_calendar_chunk'
--     and pronamespace = 'public'::regnamespace;
--
--   -- service_role can execute, anon/authenticated cannot
--   select has_function_privilege('anon', 'public.claim_pending_classify_calendar_chunk(int, interval)', 'EXECUTE'),
--          has_function_privilege('authenticated', 'public.claim_pending_classify_calendar_chunk(int, interval)', 'EXECUTE'),
--          has_function_privilege('service_role', 'public.claim_pending_classify_calendar_chunk(int, interval)', 'EXECUTE');
--
--   -- queue drain check (run twice 2 min apart after Calendar ingest)
--   select count(*) from calendar_events
--   where status = 'pending' and prep_priority is null and archived_stale = false;

-- ============================================================================
-- atomic claim helper for Calendar events
-- ============================================================================
-- Selection rule: status='pending' AND prep_priority IS NULL AND
-- archived_stale = false. Same predicate shape as the emails/slack/notion
-- RPCs but with `prep_priority` instead of `classification` (Calendar's
-- output column).
--
-- The CTE locks candidates with FOR UPDATE SKIP LOCKED so concurrent firings
-- see disjoint rows; the outer UPDATE stamps classify_claimed_at and returns
-- the columns the route needs to build the Calendar prep prompt — title,
-- description, start_at, end_at, attendee counts, organizer self-flag, and
-- the user's response status + event status (to skip declined / cancelled
-- meetings in the prompt logic).

create or replace function public.claim_pending_classify_calendar_chunk(
  p_limit int,
  p_stale_after interval default interval '5 minutes'
)
returns table (
  id uuid,
  user_id uuid,
  title text,
  description text,
  start_at timestamptz,
  end_at timestamptz,
  attendee_count int,
  external_attendee_count int,
  organizer_self boolean,
  user_response_status text,
  event_status text
)
language sql
security definer
set search_path = public
as $$
  with candidates as (
    select id
    from public.calendar_events
    where status = 'pending'
      and prep_priority is null
      and archived_stale = false
      and (classify_claimed_at is null
           or classify_claimed_at < now() - p_stale_after)
    order by created_at asc
    limit p_limit
    for update skip locked
  )
  update public.calendar_events e
  set classify_claimed_at = now()
  from candidates
  where e.id = candidates.id
  returning e.id, e.user_id, e.title, e.description, e.start_at, e.end_at,
            e.attendee_count, e.external_attendee_count, e.organizer_self,
            e.user_response_status, e.event_status;
$$;

revoke all on function public.claim_pending_classify_calendar_chunk(int, interval) from public;
-- service_role bypasses the revoke so the route can still call it. No grant
-- to authenticated — this function is server-side only.
