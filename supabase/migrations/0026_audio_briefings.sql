-- Mega-commit C 19a — audio briefing infrastructure.
--
-- Per Tab 2 spec at coordination/log.md L7534. Tables, storage bucket,
-- pg_cron registration. ADDITIVE only.
--
-- Pre-reqs (already in place at apply time):
--   - private.config row 'cron_base_url' (set by operator in earlier setup)
--   - private.config row 'cron_secret' (migration 0004)
--   - GOOGLE_TTS_API_KEY in Vercel env (verified per log L6479)
--
-- VERIFICATION QUERIES (paste output in commit body per CONVENTIONS rule 4):
--   -- (1) audio_briefings table exists with RLS enabled
--   select tablename, rowsecurity from pg_tables
--   where schemaname='public' and tablename='audio_briefings';
--
--   -- (2) columns
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema='public' and table_name='audio_briefings'
--   order by ordinal_position;
--
--   -- (3) RLS policy count (expect 1 — select_own only)
--   select policyname, cmd from pg_policies
--   where schemaname='public' and tablename='audio_briefings'
--   order by policyname;
--
--   -- (4) Storage bucket exists
--   select id, public from storage.buckets where id='audio-briefings';
--
--   -- (5) pg_cron job registered
--   select jobname, schedule from cron.job where jobname='generate-briefing';

-- ============================================================================
-- 1. audio_briefings table
-- ============================================================================
-- One row per user per day. unique(user_id, date) so cron retries upsert
-- cleanly. status='pending' on insert, generating mid-flight, ready on
-- success, failed on error. audio_url stores the Supabase Storage path
-- (signed URL minted server-side per /api/audio-briefing/today read).

create table if not exists public.audio_briefings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  briefing_date date not null,
  briefing_text text,
  audio_path text,
  duration_seconds numeric(6,2),
  status text not null default 'pending'
    check (status in ('pending', 'generating', 'ready', 'failed')),
  generated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, briefing_date)
);

create index if not exists audio_briefings_by_user_date
  on public.audio_briefings (user_id, briefing_date desc);

alter table public.audio_briefings enable row level security;

create policy audio_briefings_select_own on public.audio_briefings for select
  using (user_id = private.requesting_user_id());
-- INSERT/UPDATE happen via service_role only (cron route). No write policies.

-- ============================================================================
-- 2. Supabase Storage bucket — audio-briefings (private)
-- ============================================================================
-- Conditional create so re-apply doesn't error. Private (signed URL access);
-- /api/audio-briefing/today mints a short-TTL signed URL per request.

insert into storage.buckets (id, name, public)
select 'audio-briefings', 'audio-briefings', false
where not exists (
  select 1 from storage.buckets where id = 'audio-briefings'
);

-- Storage RLS — service_role bypasses these; authenticated/anon have no path.
-- Signed URLs are the only browser-accessible read path.

-- ============================================================================
-- 3. pg_cron — generate-briefing (hourly at :30)
-- ============================================================================
-- Hourly at minute 30 so it lands between Commit 18's signal-refresh (:10)
-- and weekly-digest (Friday 17:00 UTC). Route filters users by tz —
-- only generates when user's local hour == 6.
--
-- Why hourly: covers all 24 user-local 6am windows in a single recurring
-- pattern. Per-user generation is gated server-side in the route.

do $$ begin
  if exists (select 1 from cron.job where jobname = 'generate-briefing') then
    perform cron.unschedule('generate-briefing');
  end if;
end $$;

select cron.schedule(
  'generate-briefing',
  '30 * * * *',
  $cron$
    select net.http_post(
      url := (select private.get_secret('cron_base_url')) || '/api/cron/generate-briefing',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (select private.get_secret('cron_secret')),
        'Content-Type', 'application/json'
      )
    )
  $cron$
);
