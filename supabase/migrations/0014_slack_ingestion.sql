-- Slack ingestion — schema foundation for Commit 3 of the Slack stack.
-- Source of truth per Tab 2 coordination lock (Commit 3 architectural locks).
--
-- This migration is ADDITIVE only. The full Slack ingest stack lands here so
-- Commit 4 (classifier extension) doesn't need a schema migration — it only
-- reads/writes columns already defined here (classification, classified_at,
-- classify_claimed_at, classification_reason, classification_error, status).
--
-- Design notes worth flagging:
--   1. slack_credentials is a SEPARATE table from slack_workspaces, and has
--      RLS enabled but NO policies (default-deny pattern). bot_token is a
--      live secret — only service_role (server-side cron + OAuth callback)
--      should ever read it. Splitting into its own table guarantees that
--      a future careless `select *` from slack_workspaces in a client
--      context cannot leak the token, even if RLS misfires.
--   2. slack_messages.received_at is bigint (epoch ms) to MATCH the
--      emails.received_at convention. Slack's native ts is "epoch seconds
--      with microseconds" (e.g. "1234567890.123456"); the cron multiplies
--      by 1000 to normalize into ms-since-epoch.
--   3. UNIQUE(workspace_id, channel_id, message_ts) makes re-polls
--      idempotent — the cron upserts with ignoreDuplicates so overlapping
--      windows after a partial failure don't double-insert.
--   4. status='disconnected' is for token-revocation handling. When the
--      cron sees a SlackAuthError it flips the row and the next cron firing
--      skips it via the partial index on status='active'. Reconnect flow
--      (out of scope for this commit) re-inserts credentials and flips
--      status back to 'active'.
--   5. 7d first-poll lookback is implemented in the cron route, NOT in SQL.
--      Convention: last_polled_at IS NULL means "never polled — go back 7d";
--      otherwise poll since last_polled_at.
--
-- Style convention: text + check constraints (not Postgres enums), mirroring
-- 0012's MH schema. Easier to amend as the Slack stack evolves.
--
-- VERIFICATION QUERIES (paste output in commit body per CONVENTIONS.md rule 4):
--   -- (1) tables exist with RLS enabled
--   select tablename, rowsecurity from pg_tables where schemaname='public'
--     and tablename in ('slack_workspaces','slack_credentials','slack_messages');
--
--   -- (2) columns match spec — slack_workspaces
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema='public' and table_name='slack_workspaces'
--   order by ordinal_position;
--
--   -- (2b) columns match spec — slack_credentials
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema='public' and table_name='slack_credentials'
--   order by ordinal_position;
--
--   -- (2c) columns match spec — slack_messages
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema='public' and table_name='slack_messages'
--   order by ordinal_position;
--
--   -- (3) RLS policies attached for slack_workspaces + slack_messages
--   select tablename, policyname, cmd from pg_policies where schemaname='public'
--     and tablename in ('slack_workspaces','slack_messages')
--   order by tablename, policyname;
--
--   -- (4) NO policies on slack_credentials (count should be 0)
--   select count(*) as cred_policy_count from pg_policies
--   where schemaname='public' and tablename='slack_credentials';
--
--   -- (5) cron job registered
--   select jobname, schedule from cron.job where jobname='ingest-slack';
--
--   -- (6) indexes on hot paths
--   select indexname from pg_indexes where schemaname='public'
--     and tablename in ('slack_workspaces','slack_messages');

-- ============================================================================
-- 1. slack_workspaces — one row per (user, Slack team) installation
-- ============================================================================
-- UNIQUE(user_id, team_id) enforces "one workspace row per user per team" —
-- a re-install for the same team updates the existing row (caller does
-- ON CONFLICT in the OAuth callback) rather than spawning a duplicate.

create table if not exists public.slack_workspaces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  team_id text not null,
  team_name text,
  bot_user_id text,
  scope text,
  status text not null default 'active'
    check (status in ('active','disconnected')),
  last_polled_at timestamptz,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  unique(user_id, team_id)
);

-- Hot-read pattern: cron loops "SELECT all active workspaces, FOR EACH …".
-- Partial index keeps the cron's working set tight even as disconnected
-- workspaces accumulate over time.
create index if not exists slack_workspaces_active
  on public.slack_workspaces (user_id)
  where status = 'active';

alter table public.slack_workspaces enable row level security;

create policy slack_workspaces_select_own on public.slack_workspaces for select
  using (user_id = private.requesting_user_id());
create policy slack_workspaces_insert_own on public.slack_workspaces for insert
  with check (user_id = private.requesting_user_id());
create policy slack_workspaces_update_own on public.slack_workspaces for update
  using (user_id = private.requesting_user_id())
  with check (user_id = private.requesting_user_id());
create policy slack_workspaces_delete_own on public.slack_workspaces for delete
  using (user_id = private.requesting_user_id());

-- ============================================================================
-- 2. slack_credentials — bot_token storage, service-role-only
-- ============================================================================
-- Default-deny pattern: RLS enabled, ZERO policies. Authenticated/anon roles
-- have no path to read this table. Only service_role (server-side cron +
-- OAuth callback) can touch it, because service_role bypasses RLS entirely.
--
-- Splitting bot_token into a separate table (rather than a column on
-- slack_workspaces) is a defense-in-depth move: even if a future bug ever
-- shipped a client-side `select *` against slack_workspaces, the token can't
-- leak because it isn't in that table.
--
-- updated_at is managed by application code (OAuth re-install path), not a
-- trigger — keeps the migration lean and the rotation path explicit.

create table if not exists public.slack_credentials (
  workspace_id uuid primary key
    references public.slack_workspaces(id) on delete cascade,
  bot_token text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.slack_credentials enable row level security;
-- INTENTIONAL: no policies. Default-deny for anon/authenticated.

-- ============================================================================
-- 3. slack_messages — every IM message ingested from a Slack workspace
-- ============================================================================
-- Mirrors public.emails as much as possible:
--   - received_at as bigint (epoch ms) — matches emails convention
--   - status text with check (pending/processed/failed)
--   - classification/classification_reason/classification_error/classified_at
--     columns identical in shape to emails (Commit 4 classifier reuses them)
--   - classify_claimed_at for the SELECT FOR UPDATE SKIP LOCKED chunk-claim
--     pattern that Commit 4's RPC will implement
--
-- is_dm defaults to true — v0 only ingests DMs (conversations.list type=im).
-- Column reserved so v1 (channels, threads) doesn't need a schema migration.
--
-- archived_stale defaults to false — reserved for the v1 "auto-archive after
-- N days unread" sweep. Commit 4 doesn't read it; it's a forward-compat
-- placeholder so we don't migrate again.
--
-- raw jsonb captures the normalized SlackMessage we ingest (ts, user, text,
-- thread_ts, subtype, bot_id) — not the full Slack API JSON. The cron filters
-- to the typed shape before insert, so the raw column is a debug-aid view of
-- "what did we actually take in," not "what did Slack send." If full-fidelity
-- raw is ever needed (for v1 reactions / attachments / blocks support), the
-- cron path needs to widen first.

create table if not exists public.slack_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  workspace_id uuid not null references public.slack_workspaces(id) on delete cascade,
  channel_id text not null,
  thread_ts text,
  message_ts text not null,
  sender_id text not null,
  sender_name text,
  text text not null,
  is_dm boolean not null default true,
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
  unique(workspace_id, channel_id, message_ts)
);

-- Hot-read pattern: dashboard "show me my recent N slack messages".
create index if not exists slack_messages_by_user_recent
  on public.slack_messages (user_id, created_at desc);

-- Hot-read pattern: Commit 4 classifier RPC will claim chunks of pending
-- rows. Partial index keeps the claim scan tight regardless of how many
-- processed/failed rows accumulate over time.
create index if not exists slack_messages_pending_classify
  on public.slack_messages (workspace_id, status)
  where status = 'pending';

alter table public.slack_messages enable row level security;

create policy slack_messages_select_own on public.slack_messages for select
  using (user_id = private.requesting_user_id());
create policy slack_messages_insert_own on public.slack_messages for insert
  with check (user_id = private.requesting_user_id());
create policy slack_messages_update_own on public.slack_messages for update
  using (user_id = private.requesting_user_id())
  with check (user_id = private.requesting_user_id());
create policy slack_messages_delete_own on public.slack_messages for delete
  using (user_id = private.requesting_user_id());

-- ============================================================================
-- 4. pg_cron — ingest-slack every 15 minutes
-- ============================================================================
-- Mirrors the 0007 idempotent pattern: unschedule-if-exists then schedule.
-- Re-applying this migration cleanly replaces the schedule, so cadence
-- changes are a one-file edit + re-apply.
--
-- Cadence: '*/15 * * * *' = every 15 minutes. Per Tab 2 lock — Slack's
-- rate limits (Tier 3 = 50 req/min for conversations.history) easily cover
-- a 15-min cadence even with several active workspaces. v1 may tighten to
-- 5-min if/when DM volume warrants.
--
-- Requires private.config rows 'cron_base_url' and 'cron_secret' (see 0007
-- and 0004 for setup). No new config required for this migration.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'ingest-slack') then
    perform cron.unschedule('ingest-slack');
  end if;
end $$;

select cron.schedule(
  'ingest-slack',
  '*/15 * * * *',
  $cron$
    select net.http_post(
      url := (select private.get_secret('cron_base_url')) || '/api/cron/ingest-slack',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || (select private.get_secret('cron_secret')),
        'Content-Type',
        'application/json'
      )
    )
  $cron$
);
