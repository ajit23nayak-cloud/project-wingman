-- Mega-commit B (Commits 13a + 13b) — behavior + habits infrastructure.
--
-- This migration is ADDITIVE only. Style mirrors 0024:
--   - text + check constraints over enums (easier to amend later)
--   - RLS + _own policies keyed on private.requesting_user_id()
--   - partial indexes on hot paths only
--
-- Scope split:
--   13a (snooze + streak + DailyView rename) uses:
--     - snoozed_until columns on the 6 row-bearing surfaces (1)
--     - public.user_streaks (2) — engagement streak, NOT MH ritual streak
--     - users.timezone + users.last_dashboard_open_at (5)
--   13b (TodaysSignal + EveningReflection + WeeklyDigest) uses:
--     - public.daily_reflections (3)
--     - public.dashboard_signals (4)
--     - 3 pg_cron registrations (6)
--
-- Naming note: useStreak() at hooks.ts:757 already exists and tracks MH
-- ritual streak. The new table here backs the NEW useEngagementStreak()
-- hook + /api/streak route — distinct concept, distinct surface, no
-- collision. Decision locked by Ajit 2026-06-25 (b).
--
-- The snooze read-side filter is hook-layer work (see useEmails,
-- useSlackMessages, etc. in src/lib/supabase/hooks.ts) — this migration
-- ships the column + index; the SWR queries pick them up at read time.
--
-- VERIFICATION QUERIES (paste in commit body per CONVENTIONS rule 4):
--   -- (1) snooze columns exist on all 6 tables
--   select table_name from information_schema.columns
--   where table_schema='public' and column_name='snoozed_until'
--   order by table_name;
--
--   -- (2) user_streaks + daily_reflections + dashboard_signals exist with RLS
--   select tablename, rowsecurity from pg_tables
--   where schemaname='public'
--     and tablename in ('user_streaks','daily_reflections','dashboard_signals')
--   order by tablename;
--
--   -- (3) RLS policy count per new table (expect 3,3,1)
--   select tablename, count(*) as policy_count
--   from pg_policies
--   where schemaname='public'
--     and tablename in ('user_streaks','daily_reflections','dashboard_signals')
--   group by tablename order by tablename;
--
--   -- (4) users column additions
--   select column_name, data_type, column_default
--   from information_schema.columns
--   where table_schema='public' and table_name='users'
--     and column_name in ('timezone','last_dashboard_open_at')
--   order by column_name;
--
--   -- (5) pg_cron jobs registered (expect 3 new rows)
--   select jobname, schedule from cron.job
--   where jobname in ('evening-reflection-banner','weekly-digest','dashboard-signal-refresh')
--   order by jobname;

-- ============================================================================
-- 1. Snooze infrastructure on 6 row-bearing surfaces
-- ============================================================================
-- Each table gets a nullable timestamptz + a partial index. Dashboard list
-- queries filter `snoozed_until IS NULL OR snoozed_until <= now()` in the
-- hook layer (src/lib/supabase/hooks.ts). The partial index keeps the
-- query plan tight as snoozed rows accumulate.

alter table public.emails add column if not exists snoozed_until timestamptz;
create index if not exists emails_snoozed_until
  on public.emails (user_id, snoozed_until) where snoozed_until is not null;

alter table public.slack_messages add column if not exists snoozed_until timestamptz;
create index if not exists slack_messages_snoozed_until
  on public.slack_messages (user_id, snoozed_until) where snoozed_until is not null;

alter table public.calendar_events add column if not exists snoozed_until timestamptz;
create index if not exists calendar_events_snoozed_until
  on public.calendar_events (user_id, snoozed_until) where snoozed_until is not null;

alter table public.notion_pages add column if not exists snoozed_until timestamptz;
create index if not exists notion_pages_snoozed_until
  on public.notion_pages (user_id, snoozed_until) where snoozed_until is not null;

alter table public.contacts add column if not exists snoozed_until timestamptz;
create index if not exists contacts_snoozed_until
  on public.contacts (user_id, snoozed_until) where snoozed_until is not null;

alter table public.decisions add column if not exists snoozed_until timestamptz;
create index if not exists decisions_snoozed_until
  on public.decisions (user_id, snoozed_until) where snoozed_until is not null;

-- ============================================================================
-- 2. user_streaks — Wingman engagement streak (NOT MH ritual)
-- ============================================================================

create table if not exists public.user_streaks (
  user_id uuid primary key references public.users(id) on delete cascade,
  current_streak_days int not null default 0,
  longest_streak_days int not null default 0,
  last_activity_date date,
  total_days_active int not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.user_streaks enable row level security;

create policy user_streaks_select_own on public.user_streaks for select
  using (user_id = private.requesting_user_id());
create policy user_streaks_insert_own on public.user_streaks for insert
  with check (user_id = private.requesting_user_id());
create policy user_streaks_update_own on public.user_streaks for update
  using (user_id = private.requesting_user_id())
  with check (user_id = private.requesting_user_id());

-- ============================================================================
-- 3. daily_reflections — end-of-day 2-question form
-- ============================================================================

create table if not exists public.daily_reflections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  reflection_date date not null,
  good_today text,
  carry_tomorrow text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, reflection_date)
);

create index if not exists daily_reflections_by_user_date
  on public.daily_reflections (user_id, reflection_date desc);

alter table public.daily_reflections enable row level security;

create policy daily_reflections_select_own on public.daily_reflections for select
  using (user_id = private.requesting_user_id());
create policy daily_reflections_insert_own on public.daily_reflections for insert
  with check (user_id = private.requesting_user_id());
create policy daily_reflections_update_own on public.daily_reflections for update
  using (user_id = private.requesting_user_id())
  with check (user_id = private.requesting_user_id());

-- ============================================================================
-- 4. dashboard_signals — hourly-refreshed AI summary cache
-- ============================================================================
-- INSERT/UPDATE happen via service_role only (cron route); no write policies
-- needed. Reader takes the latest row generated in the last 60 min.

create table if not exists public.dashboard_signals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  summary_text text not null,
  source_counts jsonb,
  generated_at timestamptz not null default now()
);

create index if not exists dashboard_signals_by_user_latest
  on public.dashboard_signals (user_id, generated_at desc);

alter table public.dashboard_signals enable row level security;

create policy dashboard_signals_select_own on public.dashboard_signals for select
  using (user_id = private.requesting_user_id());

-- ============================================================================
-- 5. users column additions
-- ============================================================================
-- timezone defaults to Asia/Kolkata for India-first launch. Update per user
-- as needed (Clerk session.timezone could drive this in v1).
-- last_dashboard_open_at bumped from /api/streak/increment so the
-- dashboard-signal-refresh cron can cap Gemini spend to active users only.

alter table public.users add column if not exists timezone text default 'Asia/Kolkata';
alter table public.users add column if not exists last_dashboard_open_at timestamptz;

-- ============================================================================
-- 6. pg_cron registrations (Commit 13b consumes these)
-- ============================================================================
-- Pattern mirrors 0007_schedule_cron_jobs.sql. Requires:
--   - private.config row 'cron_base_url' (set by operator)
--   - private.config row 'cron_secret' (set in 0004)
-- All three jobs offset within the hour to avoid resource contention.

do $$ begin
  if exists (select 1 from cron.job where jobname = 'evening-reflection-banner') then
    perform cron.unschedule('evening-reflection-banner');
  end if;
end $$;

select cron.schedule(
  'evening-reflection-banner',
  '5 * * * *',
  $cron$
    select net.http_post(
      url := (select private.get_secret('cron_base_url')) || '/api/cron/evening-reflection-banner',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (select private.get_secret('cron_secret')),
        'Content-Type', 'application/json'
      )
    )
  $cron$
);

do $$ begin
  if exists (select 1 from cron.job where jobname = 'weekly-digest') then
    perform cron.unschedule('weekly-digest');
  end if;
end $$;

select cron.schedule(
  'weekly-digest',
  '0 17 * * 5',
  $cron$
    select net.http_post(
      url := (select private.get_secret('cron_base_url')) || '/api/cron/weekly-digest',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (select private.get_secret('cron_secret')),
        'Content-Type', 'application/json'
      )
    )
  $cron$
);

do $$ begin
  if exists (select 1 from cron.job where jobname = 'dashboard-signal-refresh') then
    perform cron.unschedule('dashboard-signal-refresh');
  end if;
end $$;

select cron.schedule(
  'dashboard-signal-refresh',
  '10 * * * *',
  $cron$
    select net.http_post(
      url := (select private.get_secret('cron_base_url')) || '/api/cron/dashboard-signal-refresh',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (select private.get_secret('cron_secret')),
        'Content-Type', 'application/json'
      )
    )
  $cron$
);
