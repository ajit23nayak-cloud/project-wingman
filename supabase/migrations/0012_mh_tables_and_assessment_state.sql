-- Mental Health surface — schema foundation. Source of truth for the MH
-- stack per MH_UI_SPEC.md, with the spec's L210-233 sketch interpreted as
-- intent rather than literal DDL (sketch had wrong `alter type` syntax,
-- missing PK on mh_correlations, no NOT NULL constraints, no RLS, no
-- indexes — all addressed here per Tab 2's 16:50 UTC lock).
--
-- This migration is ADDITIVE only. Schema for the full stack lands here so
-- subsequent feature commits (onboarding assessment, daily ritual, nudges,
-- on-demand triage, settings, correlation engine) don't need migrations.
-- The tier-downgrade-delete logic that's destructive (per spec L237-239)
-- lands in the later Settings UI commit, not here.
--
-- Style convention: text + check constraints (not Postgres enums). Trade-off:
-- looser type-safety vs. easier amendments as the MH spec churns through
-- v0 → v1. v1 may add 'mixed' to mh_style, or 'reset' / 'integration' to
-- mh_session_type; an enum migration for each is heavy churn. text + check
-- only requires altering the constraint.
--
-- VERIFICATION QUERIES (paste output in commit body per CONVENTIONS.md rule 4):
--   -- new users columns exist
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'users'
--     and column_name in (
--       'mh_style', 'mh_storage_tier',
--       'mh_assessment_skipped_at', 'mh_assessment_skip_count'
--     );
--
--   -- new tables exist with RLS enabled
--   select tablename, rowsecurity
--   from pg_tables
--   where schemaname = 'public' and tablename in ('mh_sessions', 'mh_correlations');
--
--   -- mh_sessions columns
--   select column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'mh_sessions'
--   order by ordinal_position;
--
--   -- RLS policies attached
--   select schemaname, tablename, policyname, cmd
--   from pg_policies
--   where schemaname = 'public'
--     and tablename in ('mh_sessions', 'mh_correlations')
--   order by tablename, policyname;
--
--   -- indexes on hot paths
--   select indexname from pg_indexes
--   where schemaname = 'public' and tablename in ('mh_sessions', 'mh_correlations');

-- ============================================================================
-- 1. users columns — assessment outcome + storage tier + skip state
-- ============================================================================
-- mh_style: nullable (NULL = assessment not yet completed). Banner on the
-- dashboard renders the assessment nudge while this is NULL.
--
-- mh_storage_tier: NOT NULL DEFAULT 2 (Aggregates). Every existing user gets
-- the safe middle tier on column add. Founder can upgrade/downgrade later
-- via Settings; downgrade-delete logic lands in a later commit.
--
-- mh_assessment_skipped_at + mh_assessment_skip_count: drive the soft re-
-- nudge. Per Tab 2 16:50 UTC lock, no cron — dashboard banner checks these
-- columns on render. Banner shows when:
--   mh_style IS NULL
--   AND (skipped_at IS NULL
--        OR (now() - skipped_at > 24h AND skip_count < 2))

alter table public.users
  add column if not exists mh_style text
    check (mh_style is null or mh_style in ('operational', 'state', 'inquiry')),
  add column if not exists mh_storage_tier int not null default 2
    check (mh_storage_tier between 1 and 4),
  add column if not exists mh_assessment_skipped_at timestamptz,
  add column if not exists mh_assessment_skip_count int not null default 0;

-- ============================================================================
-- 2. mh_sessions — every interaction with the MH surface
-- ============================================================================
-- One row per: morning ritual entry, evening ritual entry, on-demand
-- "Help me think" session, or nudge engaged. Tier gating governs which
-- columns get populated:
--   tier 1: type, framework_used, created_at — no jsonb at all
--   tier 2: + numeric_data
--   tier 3: + text_data
--   tier 4: tier 3 fields plus the correlation engine reads from here
--
-- We don't enforce the tier-vs-column gate at the DB level — the API
-- write paths in later commits do it server-side. That keeps the schema
-- simple and lets us evolve the tier semantics without a column migration.

create table if not exists public.mh_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  type text not null
    check (type in ('morning_ritual', 'evening_ritual', 'on_demand', 'nudge_engaged')),
  framework_used text not null
    check (framework_used in ('operational', 'state', 'inquiry', 'mixed')),
  numeric_data jsonb,
  text_data jsonb,
  created_at timestamptz not null default now()
);

-- Hot-read pattern: "show me my recent N sessions for this user." Compound
-- index covers both the user-scope filter and the order-by-recency without
-- needing a separate sort pass.
create index if not exists mh_sessions_by_user_recent
  on public.mh_sessions (user_id, created_at desc);

alter table public.mh_sessions enable row level security;

-- Per the Phase 1 pattern from migration 0002: RLS keyed on the Clerk JWT
-- sub claim resolved to users.id via private.requesting_user_id().
create policy mh_sessions_select_own on public.mh_sessions for select
  using (user_id = private.requesting_user_id());
create policy mh_sessions_insert_own on public.mh_sessions for insert
  with check (user_id = private.requesting_user_id());
create policy mh_sessions_update_own on public.mh_sessions for update
  using (user_id = private.requesting_user_id())
  with check (user_id = private.requesting_user_id());
create policy mh_sessions_delete_own on public.mh_sessions for delete
  using (user_id = private.requesting_user_id());

-- ============================================================================
-- 3. mh_correlations — populated nightly for Tier 4 users only
-- ============================================================================
-- This table is read-only from the client perspective. The nightly
-- correlation cron (a later commit) writes here via service_role, which
-- bypasses RLS. Authenticated users get SELECT only — they can read their
-- own correlations to populate the "Insights" surface.
--
-- No INSERT/UPDATE/DELETE policy is created on purpose — service_role
-- bypasses RLS, and we don't want authenticated users writing correlations
-- (the engine computes them; users can't fabricate).

create table if not exists public.mh_correlations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  correlation_type text not null,
  correlation_strength numeric not null,
  details jsonb,
  computed_at timestamptz not null default now()
);

create index if not exists mh_correlations_by_user
  on public.mh_correlations (user_id);

alter table public.mh_correlations enable row level security;

create policy mh_correlations_select_own on public.mh_correlations for select
  using (user_id = private.requesting_user_id());
