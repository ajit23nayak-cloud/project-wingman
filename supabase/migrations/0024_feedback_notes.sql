-- Feedback notes — in-dashboard feedback widget for Commit 12.
-- Source of truth for user-authored feedback captured anywhere in the dashboard
-- (sidebar global notes, per-row attached notes, MH banner reactions).
--
-- This migration is ADDITIVE only. Mirrors 0022 in style:
--   - text + check constraints (not Postgres enums) — easier to amend later
--   - RLS + 4 _own policies keyed on private.requesting_user_id()
--   - No pg_cron registration — feedback is user-driven, not background work
--
-- Design notes worth flagging:
--   1. Status lifecycle: open → addressed | dismissed. No transitions back to
--      'open' from a terminal state in the UI, but the schema doesn't enforce
--      that — we keep the check constraint to the three values and let the
--      product surface decide. Default is 'open' on insert.
--   2. Source linkage is OPTIONAL.
--      - dashboard_section: free-text tag for sidebar-captured notes (e.g.
--        "today_calendar", "mh_banner"). Pure analytics label, no FK.
--      - source_table + source_id: the orange-dot indicator on each row
--        joins on this pair. source_table is enum-constrained to the eight
--        row-bearing surfaces so the UI can map type → row safely.
--        source_id is text (not uuid) because emails / slack / notion all use
--        their provider-side string ids alongside our internal uuids.
--   3. Two partial indexes for the two hot reads:
--      - feedback_notes_by_user_open: sidebar "open feedback" list, scoped to
--        open status only (most rows will be terminal once a user has used
--        the widget for a few weeks).
--      - feedback_notes_by_source: per-row indicator lookup, scoped to rows
--        with a source_id (most rows won't have one; sidebar-only notes
--        skip this index).
--   4. Body length cap: 1000 chars enforced both at the API route layer
--      (returns 400 invalid_body / body_too_long) and at the DB via a CHECK
--      constraint as backstop. Titles are not length-capped at the DB —
--      the UI clamps title length; we keep the column unconstrained to
--      avoid blocking imports if we ever bulk-load notes.
--   5. v1 follow-ups (NOT implemented here):
--      - email-out digest of open feedback (CSV export already trivially
--        possible via the REST GET, so deferring).
--      - team-shared feedback (would need an org_id column; out of scope).
--
-- VERIFICATION QUERIES (paste output in commit body per CONVENTIONS.md rule 4):
--   -- (1) table exists with RLS enabled
--   select tablename, rowsecurity from pg_tables where schemaname='public'
--     and tablename = 'feedback_notes';
--
--   -- (2) columns match spec
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema='public' and table_name='feedback_notes'
--   order by ordinal_position;
--
--   -- (3) RLS policies attached (count should be 4)
--   select tablename, policyname, cmd from pg_policies where schemaname='public'
--     and tablename = 'feedback_notes'
--   order by policyname;
--
--   -- (4) indexes on hot paths (count should be 2 + pkey = 3 rows)
--   select indexname from pg_indexes where schemaname='public'
--     and tablename = 'feedback_notes'
--   order by indexname;

-- ============================================================================
-- 1. feedback_notes — one row per piece of user-authored feedback
-- ============================================================================

create table if not exists public.feedback_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  dashboard_section text,
  source_table text
    check (source_table in (
      'emails',
      'slack_messages',
      'notion_pages',
      'calendar_events',
      'contacts',
      'decisions',
      'dashboard',
      'mh_banner'
    )),
  source_id text,
  title text not null,
  body text
    check (body is null or length(body) <= 1000),
  status text not null default 'open'
    check (status in ('open','addressed','dismissed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Hot-read pattern: sidebar "your open feedback" list ordered by recency.
-- Partial index keeps the scan tight as terminal rows accumulate.
create index if not exists feedback_notes_by_user_open
  on public.feedback_notes (user_id, created_at desc)
  where status = 'open';

-- Hot-read pattern: orange-dot indicator on dashboard rows. Joins on
-- (user_id, source_table, source_id) — only rows that target a specific
-- source need to participate, so the partial WHERE keeps the index small.
create index if not exists feedback_notes_by_source
  on public.feedback_notes (user_id, source_table, source_id)
  where source_id is not null;

alter table public.feedback_notes enable row level security;

create policy feedback_notes_select_own on public.feedback_notes for select
  using (user_id = private.requesting_user_id());
create policy feedback_notes_insert_own on public.feedback_notes for insert
  with check (user_id = private.requesting_user_id());
create policy feedback_notes_update_own on public.feedback_notes for update
  using (user_id = private.requesting_user_id())
  with check (user_id = private.requesting_user_id());
create policy feedback_notes_delete_own on public.feedback_notes for delete
  using (user_id = private.requesting_user_id());
