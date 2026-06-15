-- Google Calendar ingestion — schema foundation for Phase 2b (Calendar stack).
-- Source of truth per Tab 2 coordination lock (06:05 UTC Commit 7 spec).
--
-- This migration is ADDITIVE only. Mirrors the Slack stack (0014) and Notion
-- stack (0016): the full Calendar ingest schema lands here so the classifier
-- extension (0020) doesn't need a schema migration — it only reads/writes
-- columns already defined here (prep_priority, prep_notes, prep_error,
-- classified_at, classify_claimed_at, status).
--
-- Design notes worth flagging:
--   1. calendar_credentials is a SEPARATE table from calendar_events (the
--      event facts), and has RLS enabled but NO policies (default-deny
--      pattern). access_token + refresh_token are live secrets — only
--      service_role (server-side cron + OAuth callback) should ever read
--      them. Splitting into its own table guarantees that a future careless
--      `select *` from calendar_events in a client context cannot leak the
--      token, even if RLS misfires.
--   2. Unlike Slack/Notion, there is no separate "integration" row keyed by
--      workspace_id. A user has at most one Google identity for Calendar v0
--      so calendar_credentials.user_id is the natural primary key. v1 may
--      add multi-Google-account support by promoting this to a surrogate id
--      with UNIQUE(user_id, google_account_email) — no rows to migrate at
--      that point since we're pre-launch.
--   3. calendar_events.received_at is bigint (epoch ms) to MATCH the
--      emails/slack_messages/notion_pages convention. The cron stamps
--      Date.now() at ingest time.
--   4. UNIQUE(user_id, google_event_id) makes re-polls idempotent — the cron
--      upserts (ignoreDuplicates=false → refresh title/start/end/attendees on
--      reschedule) so overlapping windows after a partial failure don't
--      double-insert AND last-minute reschedules / accepts refresh the row.
--      We key on user_id (not calendar_id) because Google sometimes returns
--      the same event_id across the user's calendars (declined-then-moved
--      etc); user_id is the safer scope for v0's single-account model.
--   5. status='disconnected' is for token-revocation handling. When the cron
--      sees an auth error it flips the row and the next firing skips it
--      (filtered by status='active' in the SELECT). Reconnect flow (out of
--      scope for this commit) re-inserts credentials and flips status back
--      to 'active'.
--   6. 15-min cadence (vs Notion's hourly) — calendar events change closer
--      to real-time (last-minute accepts, reschedules, new ad-hoc meetings)
--      so a 15-min floor is the right cadence to keep prep-priority fresh
--      for the upcoming meeting.
--   7. Time window per poll: past 1d + future 14d. Past 1d captures
--      late-decision attendance changes on meetings that already happened
--      (useful for the post-mortem signal); 14d future is roughly two
--      sprints, enough lead-time for the "upcoming meeting" surface.
--   8. event_status='cancelled' is INGESTED (not skipped) so a previously
--      surfaced meeting that gets cancelled can be visibly resolved in the
--      dashboard rather than silently disappearing.
--
-- Style convention: text + check constraints (not Postgres enums), mirroring
-- 0012/0014/0016. Easier to amend as the Calendar stack evolves.
--
-- VERIFICATION QUERIES (paste output in commit body per CONVENTIONS.md rule 4):
--   -- (1) tables exist with RLS enabled
--   select tablename, rowsecurity from pg_tables where schemaname='public'
--     and tablename in ('calendar_credentials','calendar_events');
--
--   -- (2) columns match spec — calendar_credentials
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema='public' and table_name='calendar_credentials'
--   order by ordinal_position;
--
--   -- (2b) columns match spec — calendar_events
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema='public' and table_name='calendar_events'
--   order by ordinal_position;
--
--   -- (3) RLS policies attached for calendar_events (count should be 4)
--   select tablename, policyname, cmd from pg_policies where schemaname='public'
--     and tablename = 'calendar_events'
--   order by policyname;
--
--   -- (4) NO policies on calendar_credentials (count should be 0)
--   select count(*) as cred_policy_count from pg_policies
--   where schemaname='public' and tablename='calendar_credentials';
--
--   -- (5) cron job registered
--   select jobname, schedule from cron.job where jobname='ingest-calendar';
--
--   -- (6) indexes on hot paths
--   select indexname from pg_indexes where schemaname='public'
--     and tablename in ('calendar_credentials','calendar_events');

-- ============================================================================
-- 1. calendar_credentials — one row per (user) Google Calendar connection
-- ============================================================================
-- Default-deny pattern: RLS enabled, ZERO policies. Authenticated/anon roles
-- have no path to read this table. Only service_role (server-side cron +
-- OAuth callback) can touch it, because service_role bypasses RLS entirely.
--
-- v0 model: user_id is the primary key (one Google identity per user). The
-- ON DELETE CASCADE from users(id) cleans up cleanly on account delete.
-- token_expires_at is read on every cron firing to decide whether to refresh.
-- scope is captured at install time so we can detect if a future required
-- scope wasn't granted (e.g. if we add events.write later).

create table if not exists public.calendar_credentials (
  user_id uuid primary key references public.users(id) on delete cascade,
  access_token text not null,
  refresh_token text not null,
  token_expires_at timestamptz not null,
  scope text not null,
  status text not null default 'active'
    check (status in ('active','disconnected')),
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.calendar_credentials enable row level security;
-- INTENTIONAL: no policies. Default-deny for anon/authenticated.
-- service_role bypasses RLS entirely.

-- ============================================================================
-- 2. calendar_events — every event ingested from the user's selected calendars
-- ============================================================================
-- Mirrors public.emails / slack_messages / notion_pages as much as possible:
--   - received_at as bigint (epoch ms) — matches all other ingest tables
--   - status text with check (pending/processed/failed) — same lifecycle
--   - classify_claimed_at for the SELECT FOR UPDATE SKIP LOCKED chunk-claim
--     pattern that migration 0020's RPC implements
--
-- Calendar-specific columns:
--   - prep_priority (not "classification") because the classifier output is
--     "do I need to prep for this meeting" not "is this urgent/important".
--     Four buckets: high/medium/low/none (none = no prep needed, e.g. a
--     1:1 standing meeting or a focus block).
--   - prep_notes is the short prep guidance the classifier generates
--     ("review Q3 deck attached to invite"). Surfaced in the dashboard
--     upcoming-meetings list.
--   - attendees jsonb is the raw Google attendees array (each entry has
--     email, self, organizer, responseStatus, optional). Preserved as jsonb
--     so v1 features (email pre-mention search, "who declined") don't need
--     a re-ingest.
--   - external_attendee_count is the materialized count of non-self,
--     non-organizer, non-same-domain attendees — used by the classifier
--     prompt (external attendees → higher prep priority signal) without
--     re-walking jsonb on every classify call.
--   - conference_link + conference_type extracted from conferenceData first,
--     then URL-regex'd from description (Flag 8 in Tab 2 spec).
--   - all_day boolean is materialized from start.date vs start.dateTime so
--     the dashboard can filter "skip all-day blocks" without parsing start_at.
--
-- archived_stale defaults to false — reserved for the v1 "auto-archive past
-- meetings after N days" sweep. Migration 0020 doesn't read it; it's a
-- forward-compat placeholder so we don't migrate again.
--
-- raw jsonb captures the full Google event object for debugging and v1
-- features (attachments, recurringEventId for series-level grouping, etc).

create table if not exists public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  google_calendar_id text not null,
  google_event_id text not null,
  ical_uid text,
  title text not null,
  description text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  all_day boolean not null default false,
  location text,
  conference_link text,
  conference_type text,
  organizer_email text,
  organizer_self boolean not null default false,
  attendees jsonb,
  attendee_count int,
  external_attendee_count int,
  user_response_status text
    check (user_response_status in ('accepted','tentative','declined','needsAction')),
  event_status text not null default 'confirmed'
    check (event_status in ('confirmed','tentative','cancelled')),
  prep_priority text
    check (prep_priority in ('high','medium','low','none')),
  prep_notes text,
  prep_error text,
  classified_at timestamptz,
  classify_claimed_at timestamptz,
  status text not null default 'pending'
    check (status in ('pending','processed','failed')),
  archived_stale boolean not null default false,
  raw jsonb,
  received_at bigint not null,
  created_at timestamptz not null default now(),
  unique(user_id, google_event_id)
);

-- Hot-read pattern: dashboard "show me my upcoming meetings ordered by start".
-- DESC on start_at puts the soonest/most-recent first when paired with a
-- WHERE start_at >= now() filter in the query.
create index if not exists calendar_events_by_user_start
  on public.calendar_events (user_id, start_at desc);

-- Hot-read pattern: migration 0020's classifier RPC will claim chunks of
-- pending rows. Partial index keeps the claim scan tight regardless of how
-- many processed/failed rows accumulate over time.
create index if not exists calendar_events_pending_classify
  on public.calendar_events (user_id, status)
  where status = 'pending';

alter table public.calendar_events enable row level security;

create policy calendar_events_select_own on public.calendar_events for select
  using (user_id = private.requesting_user_id());
create policy calendar_events_insert_own on public.calendar_events for insert
  with check (user_id = private.requesting_user_id());
create policy calendar_events_update_own on public.calendar_events for update
  using (user_id = private.requesting_user_id())
  with check (user_id = private.requesting_user_id());
create policy calendar_events_delete_own on public.calendar_events for delete
  using (user_id = private.requesting_user_id());

-- ============================================================================
-- 3. pg_cron — ingest-calendar every 15 minutes
-- ============================================================================
-- Mirrors the 0007/0014/0016 idempotent pattern: unschedule-if-exists then
-- schedule. Re-applying this migration cleanly replaces the schedule, so
-- cadence changes are a one-file edit + re-apply.
--
-- Cadence: '*/15 * * * *' = every 15 minutes. Per Tab 2 lock — calendar
-- events change closer to real-time (last-minute accepts, reschedules) than
-- Notion pages, so we match Slack's 15-min cadence rather than Notion's
-- hourly. Google Calendar's per-user rate limit (~1M queries/day at the
-- project level, with per-user quotas well above this poll rate) easily
-- covers 15-min cadence even with many users.
--
-- Requires private.config rows 'cron_base_url' and 'cron_secret' (see 0007
-- and 0004 for setup). No new config required for this migration.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'ingest-calendar') then
    perform cron.unschedule('ingest-calendar');
  end if;
end $$;

select cron.schedule(
  'ingest-calendar',
  '*/15 * * * *',
  $cron$
    select net.http_post(
      url := (select private.get_secret('cron_base_url')) || '/api/cron/ingest-calendar',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || (select private.get_secret('cron_secret')),
        'Content-Type',
        'application/json'
      )
    )
  $cron$
);
