-- Decision log — schema foundation for Phase 3 (Commit 8).
-- Source of truth per Tab 2 coordination lock (09:35 UTC spec).
--
-- This migration is ADDITIVE only. Mirrors 0014/0016/0019/0021 in style:
--   - text + check constraints (not Postgres enums)
--   - RLS + 4 _own policies keyed on private.requesting_user_id()
--   - pg_cron registered at the bottom with idempotent unschedule + reschedule
--
-- Design notes worth flagging:
--   1. Lifecycle statuses: drafted → committed → postmortem_due → reviewed.
--      - drafted: user is mid-capture, no commitment yet.
--      - committed: user marked the decision as "this is what I'm doing".
--        postmortem_due_at is set when status flips to committed (user-chosen
--        review date — defaults to +30 days in the UI but is editable).
--      - postmortem_due: the decision-postmortem-reminder cron (daily at
--        09:00 UTC) flips committed rows past their postmortem_due_at to
--        this state and stamps postmortem_reminded_at. The dashboard
--        surfaces these to the user as "time to review."
--      - reviewed: user has filled in the postmortem field. Terminal state.
--   2. linked_source_kind / linked_source_id — optional pointer to the
--      ingested item that triggered the decision (an email thread, a Slack
--      message, a Notion page, a calendar invite). Stored as a kind-tag +
--      free text id rather than a FK because the source row may be archived
--      (archived_stale=true) but the decision lives forever.
--   3. options_considered + reasoning + premortem are nullable jsonb/text —
--      the v0 capture flow doesn't enforce them, but the schema reserves
--      the slot so we never re-migrate when the UI tightens.
--   4. postmortem_reminded_at debounces the daily reminder cron: a row
--      flipped to postmortem_due yesterday should NOT get flipped again
--      today. The cron's WHERE clause checks
--      `postmortem_reminded_at IS NULL OR postmortem_reminded_at < now() - interval '24 hours'`.
--   5. v1 hardening (NOT implemented in this commit):
--      - Notion @mention extraction (auto-create decisions from Notion pages
--        where the user @-mentions themselves with a decision keyword).
--      - AI-suggested decisions from email/Slack threads.
--      Both lift directly into the existing schema (linked_source_kind +
--      source_id covers the linkage; no new columns needed).
--
-- VERIFICATION QUERIES (paste output in commit body per CONVENTIONS.md rule 4):
--   -- (1) table exists with RLS enabled
--   select tablename, rowsecurity from pg_tables where schemaname='public'
--     and tablename = 'decisions';
--
--   -- (2) columns match spec
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema='public' and table_name='decisions'
--   order by ordinal_position;
--
--   -- (3) RLS policies attached (count should be 4)
--   select tablename, policyname, cmd from pg_policies where schemaname='public'
--     and tablename = 'decisions'
--   order by policyname;
--
--   -- (4) cron job registered
--   select jobname, schedule from cron.job
--   where jobname='decision-postmortem-reminder';
--
--   -- (5) indexes on hot paths
--   select indexname from pg_indexes where schemaname='public'
--     and tablename = 'decisions';

-- ============================================================================
-- 1. decisions — one row per decision the user has logged
-- ============================================================================

create table if not exists public.decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  title text not null,
  decision_made_at timestamptz not null default now(),
  context text,
  options_considered jsonb,
  decision text,
  reasoning text,
  premortem text,
  postmortem text,
  postmortem_due_at timestamptz,
  postmortem_reminded_at timestamptz,
  status text not null default 'drafted'
    check (status in ('drafted','committed','postmortem_due','reviewed')),
  linked_source_kind text
    check (linked_source_kind in ('email','slack','notion','calendar')),
  linked_source_id text,
  tags jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Hot-read pattern: dashboard "your recent decisions" list ordered by
-- when the decision was made.
create index if not exists decisions_by_user_made
  on public.decisions (user_id, decision_made_at desc);

-- Hot-read pattern: the postmortem-reminder cron scans for committed (or
-- already-flipped postmortem_due) rows with no postmortem yet whose due
-- date has passed. Partial index keeps the scan tight as decisions
-- accumulate (most are 'reviewed' or 'drafted' and excluded here).
create index if not exists decisions_postmortem_due
  on public.decisions (user_id, postmortem_due_at)
  where status in ('committed','postmortem_due') and postmortem is null;

alter table public.decisions enable row level security;

create policy decisions_select_own on public.decisions for select
  using (user_id = private.requesting_user_id());
create policy decisions_insert_own on public.decisions for insert
  with check (user_id = private.requesting_user_id());
create policy decisions_update_own on public.decisions for update
  using (user_id = private.requesting_user_id())
  with check (user_id = private.requesting_user_id());
create policy decisions_delete_own on public.decisions for delete
  using (user_id = private.requesting_user_id());

-- ============================================================================
-- 2. pg_cron — decision-postmortem-reminder daily at 09:00 UTC
-- ============================================================================
-- Mirrors the 0007/0014/0016/0019/0021 idempotent pattern: unschedule-if-exists
-- then schedule. Re-applying this migration cleanly replaces the schedule.
--
-- Cadence: '0 9 * * *' = every day at 09:00 UTC. Chosen because:
--   - Daily is fine — postmortem due dates are user-set (typically +30
--     days from commit), so single-day precision is plenty.
--   - 09:00 UTC ≈ start-of-day in Asia / mid-morning in EU / late-evening
--     before-bed in US-west; the user is likely to be active or about to
--     be active in at least one timezone window, so the surfaced
--     "review this decision" lands when the dashboard is being looked at.
--   - Offset from the contacts cron (02:00 UTC) so the two crons don't
--     race for resources or each other's recently-touched rows.
--
-- Requires private.config rows 'cron_base_url' and 'cron_secret' (see 0007
-- and 0004 for setup). No new config required for this migration.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'decision-postmortem-reminder') then
    perform cron.unschedule('decision-postmortem-reminder');
  end if;
end $$;

select cron.schedule(
  'decision-postmortem-reminder',
  '0 9 * * *',
  $cron$
    select net.http_post(
      url := (select private.get_secret('cron_base_url')) || '/api/cron/decision-postmortem-reminder',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || (select private.get_secret('cron_secret')),
        'Content-Type',
        'application/json'
      )
    )
  $cron$
);
