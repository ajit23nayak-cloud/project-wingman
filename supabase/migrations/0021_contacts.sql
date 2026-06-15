-- Personal CRM — schema foundation for Phase 3 (Commit 8).
-- Source of truth per Tab 2 coordination lock (09:35 UTC spec) +
-- Tab 1 pushback micro-defaults (D1/D2/D4).
--
-- This migration is ADDITIVE only. Mirrors the slack/notion/calendar stacks
-- (0014/0016/0019) in style:
--   - text + check constraints (not Postgres enums)
--   - RLS + 4 _own policies keyed on private.requesting_user_id()
--   - pg_cron registered at the bottom with idempotent unschedule + reschedule
--
-- Design notes worth flagging:
--   1. NO new OAuth. The aggregate-contacts cron derives contacts from
--      EXISTING ingested tables: emails, slack_messages, calendar_events,
--      notion_pages. There is no third-party contacts API in v0.
--   2. Identity key for email-known contacts: UNIQUE(user_id, primary_email).
--      For Slack-only contacts (no email known — DM partner whose email we
--      can't resolve), we set primary_slack_user_id and leave primary_email
--      null. Tab 1 D1 micro-default: the cron uses a two-step upsert for
--      these (SELECT by primary_slack_user_id; UPDATE if exists, INSERT if
--      not) because we can't UNIQUE on a nullable column with predictable
--      semantics across email-known + slack-only rows in the same table.
--      The CHECK constraint enforces at least one identifier is present.
--   3. cadence_break_days (Tab 1 D2): the aggregate cron computes
--      `floor((now - last_seen_at) / 86400000)` and sets it ONLY when > 28
--      (else NULL). The partial index on cadence_break_days makes the
--      "people you've gone cold on" dashboard surface a tight scan.
--   4. manual_notes / manual_tags / archived are USER-EDITED columns. The
--      cron deliberately does NOT clobber these on re-aggregate. Strategy:
--      update only the aggregated columns (display_name, last_seen_at,
--      counts, cadence_break_days, last_seen_source, aliases). Manual
--      columns survive untouched.
--   5. aliases jsonb captures alternative emails / slack ids the cron has
--      seen for the same person (e.g. work + personal email both used in
--      the user's inbox). For v0 the cron keys on the canonical
--      primary_email; aliases is a forward-compat capture so v1 can do
--      cross-identity merging without a re-ingest.
--   6. Performance indexes (Tab 1 D4): the /contacts/[id] detail surface
--      needs "show me last 30 days of interactions" — that means scanning
--      emails by (user_id, from_address), slack_messages by (user_id,
--      sender_id), and calendar_events by jsonb attendees membership.
--      These three indexes are added here (rather than retroactively to
--      0002/0014/0019) so the CRM stack ships self-contained.
--
-- VERIFICATION QUERIES (paste output in commit body per CONVENTIONS.md rule 4):
--   -- (1) table exists with RLS enabled
--   select tablename, rowsecurity from pg_tables where schemaname='public'
--     and tablename = 'contacts';
--
--   -- (2) columns match spec
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema='public' and table_name='contacts'
--   order by ordinal_position;
--
--   -- (3) RLS policies attached (count should be 4)
--   select tablename, policyname, cmd from pg_policies where schemaname='public'
--     and tablename = 'contacts'
--   order by policyname;
--
--   -- (4) cron job registered
--   select jobname, schedule from cron.job where jobname='aggregate-contacts';
--
--   -- (5) indexes on hot paths (contacts + perf indexes on source tables)
--   select indexname from pg_indexes where schemaname='public'
--     and (tablename = 'contacts'
--          or indexname in ('idx_emails_from_address',
--                           'idx_slack_messages_sender',
--                           'idx_calendar_events_attendees_gin'));

-- ============================================================================
-- 1. contacts — one row per (user, person) the user interacts with
-- ============================================================================
-- Aggregated from emails + slack_messages + calendar_events + notion_pages
-- by the aggregate-contacts cron (daily at 0 2 * * *).
--
-- Identity rule: primary_email is the canonical key when known. When not
-- known (Slack-only contact), primary_slack_user_id carries the identity.
-- CHECK constraint guarantees at least one is set. The UNIQUE(user_id,
-- primary_email) supports postgrest upsert with onConflict for the
-- common email-known path; the slack-only path uses two-step upsert via
-- SELECT-then-INSERT-or-UPDATE because nullable UNIQUE has Postgres-treated
-- semantics ("two NULLs are distinct") that we don't want to rely on.

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  primary_email text,
  primary_slack_user_id text,
  display_name text not null,
  aliases jsonb,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  last_seen_source text not null
    check (last_seen_source in ('email','slack','calendar','notion')),
  total_interactions_lifetime int not null default 0,
  total_interactions_30d int not null default 0,
  cadence_break_days int,
  manual_notes text,
  manual_tags jsonb,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, primary_email),
  check (primary_email is not null or primary_slack_user_id is not null)
);

-- Hot-read pattern: dashboard "recent contacts" list ordered by last_seen.
-- Partial index excludes archived rows so the scan stays tight.
create index if not exists contacts_by_user_last_seen
  on public.contacts (user_id, last_seen_at desc)
  where archived = false;

-- Hot-read pattern: "people you've gone cold on" surface. Partial index
-- restricted to rows where cadence_break_days is set (i.e. > 28 days) and
-- not archived — typical row count is single digits to low hundreds.
create index if not exists contacts_cadence_break
  on public.contacts (user_id, cadence_break_days desc)
  where cadence_break_days is not null and archived = false;

alter table public.contacts enable row level security;

create policy contacts_select_own on public.contacts for select
  using (user_id = private.requesting_user_id());
create policy contacts_insert_own on public.contacts for insert
  with check (user_id = private.requesting_user_id());
create policy contacts_update_own on public.contacts for update
  using (user_id = private.requesting_user_id())
  with check (user_id = private.requesting_user_id());
create policy contacts_delete_own on public.contacts for delete
  using (user_id = private.requesting_user_id());

-- ============================================================================
-- 2. Performance indexes on source tables (Tab 1 D4)
-- ============================================================================
-- These indexes back the /contacts/[id] detail surface's "recent
-- interactions" query — which scans the SOURCE tables (emails,
-- slack_messages, calendar_events) by the contact's identifier.
--
-- Added here (rather than retroactively to 0002 / 0014 / 0019) so the CRM
-- stack ships as a self-contained unit and the diff is reviewable in one
-- place. `if not exists` keeps re-apply safe.
--
--   - emails: lookup by (user_id, from_address) for "emails from this person"
--   - slack_messages: lookup by (user_id, sender_id) for "DMs from this person"
--   - calendar_events: GIN on attendees jsonb (jsonb_path_ops variant — half
--     the size of the default jsonb_ops and sufficient for the @> containment
--     query the contact-detail page runs)

create index if not exists idx_emails_from_address
  on public.emails (user_id, from_address);

create index if not exists idx_slack_messages_sender
  on public.slack_messages (user_id, sender_id);

create index if not exists idx_calendar_events_attendees_gin
  on public.calendar_events using gin (attendees jsonb_path_ops);

-- ============================================================================
-- 3. pg_cron — aggregate-contacts daily at 02:00 UTC
-- ============================================================================
-- Mirrors the 0007/0014/0016/0019 idempotent pattern: unschedule-if-exists
-- then schedule. Re-applying this migration cleanly replaces the schedule.
--
-- Cadence: '0 2 * * *' = every day at 02:00 UTC. Chosen because:
--   - Daily is fine — contact aggregates are derived from ingested rows
--     that themselves update every 15min/hour; nightly rebuild gives a
--     consistent snapshot for morning surfaces.
--   - 02:00 UTC ≈ off-peak globally for the cron path; no contention with
--     the more frequent ingest crons (most of which run at */15 or hourly
--     offsets).
--
-- Requires private.config rows 'cron_base_url' and 'cron_secret' (see 0007
-- and 0004 for setup). No new config required for this migration.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'aggregate-contacts') then
    perform cron.unschedule('aggregate-contacts');
  end if;
end $$;

select cron.schedule(
  'aggregate-contacts',
  '0 2 * * *',
  $cron$
    select net.http_post(
      url := (select private.get_secret('cron_base_url')) || '/api/cron/aggregate-contacts',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || (select private.get_secret('cron_secret')),
        'Content-Type',
        'application/json'
      )
    )
  $cron$
);
