-- Notion ingestion — schema foundation for Phase 2a (Notion stack).
-- Source of truth per Tab 2 coordination lock (17:30 UTC spec).
--
-- This migration is ADDITIVE only. Mirrors the Slack stack (migration 0014):
-- the full Notion ingest schema lands here so the classifier extension
-- (migration 0017) doesn't need a schema migration — it only reads/writes
-- columns already defined here (classification, classified_at,
-- classify_claimed_at, classification_reason, classification_error, status).
--
-- Design notes worth flagging:
--   1. notion_credentials is a SEPARATE table from notion_integrations, and
--      has RLS enabled but NO policies (default-deny pattern). access_token
--      is a live secret — only service_role (server-side cron + OAuth
--      callback) should ever read it. Splitting into its own table guarantees
--      that a future careless `select *` from notion_integrations in a
--      client context cannot leak the token, even if RLS misfires.
--   2. notion_pages.received_at is bigint (epoch ms) to MATCH the
--      emails.received_at and slack_messages.received_at conventions. The
--      cron derives it from Notion's last_edited_time (ISO 8601) via
--      Date.parse → getTime().
--   3. UNIQUE(integration_id, page_id) makes re-polls idempotent — the cron
--      upserts (ignoreDuplicates=false → refresh snippet/title/last_edited_at
--      on edit) so overlapping windows after a partial failure don't
--      double-insert AND edits to already-ingested pages refresh.
--   4. status='disconnected' is for token-revocation handling. When the
--      cron sees a NotionAuthError it flips the row and the next cron firing
--      skips it via the partial index on status='active'. Reconnect flow
--      (out of scope for this commit) re-inserts credentials and flips
--      status back to 'active'.
--   5. 7d first-poll lookback is implemented in the cron route, NOT in SQL.
--      Convention: last_polled_at IS NULL means "never polled — go back 7d";
--      otherwise poll since last_polled_at.
--   6. Pages only (not databases) for v0 per Flag C. v1 may add a
--      data_source_type column without a migration if needed.
--
-- Style convention: text + check constraints (not Postgres enums), mirroring
-- 0012's MH schema and 0014's Slack schema. Easier to amend as the Notion
-- stack evolves.
--
-- VERIFICATION QUERIES (paste output in commit body per CONVENTIONS.md rule 4):
--   -- (1) tables exist with RLS enabled
--   select tablename, rowsecurity from pg_tables where schemaname='public'
--     and tablename in ('notion_integrations','notion_credentials','notion_pages');
--
--   -- (2) columns match spec — notion_integrations
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema='public' and table_name='notion_integrations'
--   order by ordinal_position;
--
--   -- (2b) columns match spec — notion_credentials
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema='public' and table_name='notion_credentials'
--   order by ordinal_position;
--
--   -- (2c) columns match spec — notion_pages
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema='public' and table_name='notion_pages'
--   order by ordinal_position;
--
--   -- (3) RLS policies attached for notion_integrations + notion_pages
--   select tablename, policyname, cmd from pg_policies where schemaname='public'
--     and tablename in ('notion_integrations','notion_pages')
--   order by tablename, policyname;
--
--   -- (4) NO policies on notion_credentials (count should be 0)
--   select count(*) as cred_policy_count from pg_policies
--   where schemaname='public' and tablename='notion_credentials';
--
--   -- (5) cron job registered
--   select jobname, schedule from cron.job where jobname='ingest-notion';
--
--   -- (6) indexes on hot paths
--   select indexname from pg_indexes where schemaname='public'
--     and tablename in ('notion_integrations','notion_pages');

-- ============================================================================
-- 1. notion_integrations — one row per (user, Notion workspace) installation
-- ============================================================================
-- UNIQUE(user_id, workspace_id) enforces "one integration row per user per
-- workspace" — a re-install for the same workspace updates the existing row
-- (caller does ON CONFLICT in the OAuth callback) rather than spawning a
-- duplicate.

create table if not exists public.notion_integrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  workspace_id text not null,
  workspace_name text,
  workspace_icon text,
  bot_id text,
  status text not null default 'active'
    check (status in ('active','disconnected')),
  last_polled_at timestamptz,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  unique(user_id, workspace_id)
);

-- Hot-read pattern: cron loops "SELECT all active integrations, FOR EACH …".
-- Partial index keeps the cron's working set tight even as disconnected
-- integrations accumulate over time.
create index if not exists notion_integrations_active
  on public.notion_integrations (user_id)
  where status = 'active';

alter table public.notion_integrations enable row level security;

create policy notion_integrations_select_own on public.notion_integrations for select
  using (user_id = private.requesting_user_id());
create policy notion_integrations_insert_own on public.notion_integrations for insert
  with check (user_id = private.requesting_user_id());
create policy notion_integrations_update_own on public.notion_integrations for update
  using (user_id = private.requesting_user_id())
  with check (user_id = private.requesting_user_id());
create policy notion_integrations_delete_own on public.notion_integrations for delete
  using (user_id = private.requesting_user_id());

-- ============================================================================
-- 2. notion_credentials — access_token storage, service-role-only
-- ============================================================================
-- Default-deny pattern: RLS enabled, ZERO policies. Authenticated/anon roles
-- have no path to read this table. Only service_role (server-side cron +
-- OAuth callback) can touch it, because service_role bypasses RLS entirely.
--
-- Splitting access_token into a separate table (rather than a column on
-- notion_integrations) is a defense-in-depth move: even if a future bug ever
-- shipped a client-side `select *` against notion_integrations, the token
-- can't leak because it isn't in that table.
--
-- updated_at is managed by application code (OAuth re-install path), not a
-- trigger — keeps the migration lean and the rotation path explicit.

create table if not exists public.notion_credentials (
  integration_id uuid primary key
    references public.notion_integrations(id) on delete cascade,
  access_token text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.notion_credentials enable row level security;
-- INTENTIONAL: no policies. Default-deny for anon/authenticated.

-- ============================================================================
-- 3. notion_pages — every Notion page ingested from a workspace
-- ============================================================================
-- Mirrors public.emails and public.slack_messages as much as possible:
--   - received_at as bigint (epoch ms) — matches emails/slack convention
--   - status text with check (pending/processed/failed)
--   - classification/classification_reason/classification_error/classified_at
--     columns identical in shape to emails/slack_messages
--   - classify_claimed_at for the SELECT FOR UPDATE SKIP LOCKED chunk-claim
--     pattern that migration 0017's RPC implements
--
-- snippet = title + first 500 chars of body (Flag B). Built in the cron
-- route from a recursive walk of paragraph/heading/bulleted_list_item/
-- numbered_list_item/toggle/quote/callout blocks, concat with spaces.
--
-- archived_stale defaults to false — reserved for the v1 "auto-archive after
-- N days untouched" sweep. Migration 0017 doesn't read it; it's a forward-
-- compat placeholder so we don't migrate again.
--
-- raw jsonb captures the Notion page object MINUS its block children for
-- debugging. Block contents are folded into `snippet` (the 500-char slice);
-- storing raw blocks would balloon the table and isn't needed for the
-- classifier prompt.

create table if not exists public.notion_pages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  integration_id uuid not null references public.notion_integrations(id) on delete cascade,
  page_id text not null,
  title text not null,
  snippet text not null,
  last_edited_at timestamptz not null,
  url text,
  classification text
    check (classification in ('urgent','important','fyi','archive')),
  classification_reason text,
  classification_error text,
  classified_at timestamptz,
  classify_claimed_at timestamptz,
  status text not null default 'pending'
    check (status in ('pending','processed','failed')),
  archived_stale boolean not null default false,
  received_at bigint not null,
  raw jsonb,
  created_at timestamptz not null default now(),
  unique(integration_id, page_id)
);

-- Hot-read pattern: dashboard "show me my recent N notion pages".
create index if not exists notion_pages_by_user_recent
  on public.notion_pages (user_id, created_at desc);

-- Hot-read pattern: migration 0017's classifier RPC will claim chunks of
-- pending rows. Partial index keeps the claim scan tight regardless of how
-- many processed/failed rows accumulate over time.
create index if not exists notion_pages_pending_classify
  on public.notion_pages (integration_id, status)
  where status = 'pending';

alter table public.notion_pages enable row level security;

create policy notion_pages_select_own on public.notion_pages for select
  using (user_id = private.requesting_user_id());
create policy notion_pages_insert_own on public.notion_pages for insert
  with check (user_id = private.requesting_user_id());
create policy notion_pages_update_own on public.notion_pages for update
  using (user_id = private.requesting_user_id())
  with check (user_id = private.requesting_user_id());
create policy notion_pages_delete_own on public.notion_pages for delete
  using (user_id = private.requesting_user_id());

-- ============================================================================
-- 4. pg_cron — ingest-notion every hour at minute 0
-- ============================================================================
-- Mirrors the 0007/0014 idempotent pattern: unschedule-if-exists then schedule.
-- Re-applying this migration cleanly replaces the schedule, so cadence
-- changes are a one-file edit + re-apply.
--
-- Cadence: '0 * * * *' = every hour at minute 0. Per Tab 2 lock — Notion's
-- rate limits are tight (avg 3 req/sec per integration) and pages move much
-- more slowly than Slack messages, so hourly cadence is the right floor.
-- v1 may tighten to 30-min if/when active editing patterns warrant.
--
-- Requires private.config rows 'cron_base_url' and 'cron_secret' (see 0007
-- and 0004 for setup). No new config required for this migration.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'ingest-notion') then
    perform cron.unschedule('ingest-notion');
  end if;
end $$;

select cron.schedule(
  'ingest-notion',
  '0 * * * *',
  $cron$
    select net.http_post(
      url := (select private.get_secret('cron_base_url')) || '/api/cron/ingest-notion',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || (select private.get_secret('cron_secret')),
        'Content-Type',
        'application/json'
      )
    )
  $cron$
);
