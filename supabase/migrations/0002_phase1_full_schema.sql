-- Phase 1 full schema: emails, voice_samples, classification_progress, drafts,
-- waitlist. users already created in 0001. voiceProfiles dropped — Convex
-- defined it but nothing referenced it. Idempotency enforced at DB layer via
-- UNIQUE constraints (per Flag 1 of the pre-build pushback). RLS on every
-- user-scoped table, keyed on Clerk JWT sub claim through a helper function.
--
-- Apply via Supabase dashboard → SQL Editor → Run.

-- ============================================================================
-- Helper: resolve current request's Clerk user → users.id (uuid)
-- ============================================================================
-- STABLE: Postgres caches per query, so RLS only pays the users-lookup once
-- per SELECT, not per row. SECURITY DEFINER: function runs as its owner
-- (postgres), bypassing RLS on users — otherwise it would recurse. The
-- explicit search_path closes off search-path hijacking.

create schema if not exists private;

create or replace function private.requesting_user_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.users where clerk_user_id = auth.jwt() ->> 'sub'
$$;

grant usage on schema private to authenticated;
grant execute on function private.requesting_user_id() to authenticated;

-- ============================================================================
-- Enums (shared across tables)
-- ============================================================================

create type email_classification as enum ('urgent', 'important', 'fyi', 'archive');
create type email_status as enum ('pending', 'processed', 'failed');
create type voice_segment as enum ('cold_outreach', 'internal_team', 'investor_ish', 'casual_peer');
create type reply_type as enum ('ack', 'decline', 'question', 'propose', 'info');
create type reply_status as enum ('unsent', 'sent');
create type classification_mode as enum ('pending', 'failed');
create type waitlist_status as enum ('pending', 'invited', 'rejected');

-- ============================================================================
-- emails
-- ============================================================================

create table emails (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  gmail_message_id text not null,
  thread_id text not null,
  from_address text not null,
  to_addresses text[] not null default '{}',
  subject text not null,
  snippet text not null,
  received_at bigint not null,
  classification email_classification,
  classification_reason text,
  classification_error text,
  classified_at bigint,
  segment_used voice_segment,
  status email_status not null default 'pending',
  processed_at bigint,
  -- Day 7 active-pool cap: rows aged out are flagged here so dashboard reads
  -- can exclude without dropping the data. Partial index below makes the
  -- "active emails for user" hot path efficient.
  archived_stale boolean not null default false,
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  -- Idempotency: re-ingesting the same Gmail message for the same user is a
  -- no-op via ON CONFLICT, not a duplicate insert.
  unique (user_id, gmail_message_id)
);

create index emails_by_user on emails (user_id);
create index emails_by_user_classification on emails (user_id, classification);
create index emails_active_by_user on emails (user_id) where archived_stale = false;
create index emails_pending_by_user on emails (user_id)
  where status = 'pending' and classification is null;

alter table emails enable row level security;

create policy emails_select_own on emails for select
  using (user_id = private.requesting_user_id());
create policy emails_insert_own on emails for insert
  with check (user_id = private.requesting_user_id());
create policy emails_update_own on emails for update
  using (user_id = private.requesting_user_id())
  with check (user_id = private.requesting_user_id());
create policy emails_delete_own on emails for delete
  using (user_id = private.requesting_user_id());

-- ============================================================================
-- voice_samples
-- ============================================================================

create table voice_samples (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  gmail_message_id text not null,
  snippet text not null,
  subject text,
  reply_type reply_type not null,
  segment voice_segment not null,
  segment_confidence double precision not null,
  sent_at bigint not null,
  ingested_at bigint not null,
  unique (user_id, gmail_message_id)
);

create index voice_samples_by_user on voice_samples (user_id);
create index voice_samples_by_user_segment on voice_samples (user_id, segment);

alter table voice_samples enable row level security;

create policy voice_samples_select_own on voice_samples for select
  using (user_id = private.requesting_user_id());
create policy voice_samples_insert_own on voice_samples for insert
  with check (user_id = private.requesting_user_id());
create policy voice_samples_update_own on voice_samples for update
  using (user_id = private.requesting_user_id())
  with check (user_id = private.requesting_user_id());
create policy voice_samples_delete_own on voice_samples for delete
  using (user_id = private.requesting_user_id());

-- ============================================================================
-- classification_progress
-- ============================================================================
-- 1:1 with users. PK is user_id so there is exactly one progress row per
-- user; a new chunked-classify run overwrites the existing row (UPSERT in
-- the action). No per-history retention — if we want history later, we add
-- a classification_runs table.

create table classification_progress (
  user_id uuid primary key references users(id) on delete cascade,
  total_to_process integer not null,
  processed integer not null default 0,
  classified integer not null default 0,
  failed integer not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  mode classification_mode not null,
  started_at bigint not null,
  completed_at bigint
);

alter table classification_progress enable row level security;

create policy classification_progress_select_own on classification_progress for select
  using (user_id = private.requesting_user_id());
create policy classification_progress_insert_own on classification_progress for insert
  with check (user_id = private.requesting_user_id());
create policy classification_progress_update_own on classification_progress for update
  using (user_id = private.requesting_user_id())
  with check (user_id = private.requesting_user_id());

-- ============================================================================
-- drafts
-- ============================================================================
-- 1:1 with emails — UNIQUE(email_id) enforces it. Convex inlined these fields
-- on emails; splitting here per Phase 1 spec. user_id is denormalized for
-- RLS so the policy is a direct compare, not a join through emails.

create table drafts (
  id uuid primary key default gen_random_uuid(),
  email_id uuid not null unique references emails(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  body text not null,
  generated_at bigint not null,
  edited_at bigint,
  segment_used voice_segment,
  -- voice_samples.id values that fed the draft prompt — powers the
  -- "why does this draft sound this way" debug panel.
  snippet_indices_used uuid[] not null default '{}',
  status reply_status not null default 'unsent',
  reply_message_id text,
  replied_at bigint
);

create index drafts_by_user on drafts (user_id);

alter table drafts enable row level security;

create policy drafts_select_own on drafts for select
  using (user_id = private.requesting_user_id());
create policy drafts_insert_own on drafts for insert
  with check (user_id = private.requesting_user_id());
create policy drafts_update_own on drafts for update
  using (user_id = private.requesting_user_id())
  with check (user_id = private.requesting_user_id());
create policy drafts_delete_own on drafts for delete
  using (user_id = private.requesting_user_id());

-- ============================================================================
-- waitlist
-- ============================================================================
-- Special table: no user_id (signup happens before account creation).
-- INSERT is open to anon (landing-page signup). SELECT has no policy, so
-- default-deny — admin reads go through a server route using service_role.

create table waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  company text not null,
  overload_response text not null,
  status waitlist_status not null default 'pending',
  invited_at bigint,
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);

create index waitlist_by_created_at on waitlist (created_at);

alter table waitlist enable row level security;

create policy waitlist_insert_public on waitlist for insert
  to anon, authenticated
  with check (true);
