-- MH safety boundary system — escalation log table. Populated by the safety
-- screen (regex pre-LLM or LLM-detected) whenever a user message trips the
-- crisis-content rules in src/lib/mh/safety/screen.ts + chatPrompt.ts's
-- SAFETY block.
--
-- Per Tab 2 01:05 UTC + Ajit all-8 lock: NO admin route in v0 (just log to
-- this table + PostHog). NO content stored — only metadata (region, source
-- route, detection layer, timestamp). The proactive dashboard nudge at
-- >=3 escalations in 7 days reads count(*) from this table for the user.
--
-- VERIFICATION QUERIES (paste output in commit body per CONVENTIONS.md
-- rule 4):
--   -- table exists with RLS enabled
--   select tablename, rowsecurity from pg_tables
--   where schemaname = 'public' and tablename = 'mh_escalations';
--
--   -- column shape
--   select column_name, data_type, is_nullable from information_schema.columns
--   where table_schema = 'public' and table_name = 'mh_escalations'
--   order by ordinal_position;
--
--   -- SELECT policy attached, no INSERT/UPDATE/DELETE policy (service_role only writes)
--   select policyname, cmd from pg_policies
--   where schemaname = 'public' and tablename = 'mh_escalations';

create table if not exists public.mh_escalations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  -- Region detected from Clerk session timezone at the moment of escalation.
  -- One of: IN, US, UK, EU, OTHER. text + check (vs enum) per the v0 style
  -- convention in 0012 — easier to amend as Wingman's region list grows.
  region text not null check (region in ('IN', 'US', 'UK', 'EU', 'OTHER')),
  -- Which Wingman surface produced the escalation. v0 has only one source
  -- (chat fallback in Help me think), but spec'd as text for v1 expansion
  -- to ritual-text triggers / nudge-text triggers.
  source_route text not null,
  -- Which detection layer caught it: 'regex' (Layer 1 pre-LLM screen) or
  -- 'llm' (Layer 2 SAFETY block in chatPrompt.ts). Useful for measuring
  -- regex pattern coverage in v1.
  detection_layer text not null check (detection_layer in ('regex', 'llm')),
  created_at timestamptz not null default now()
);

-- Hot-read pattern: count(*) for the last 7 days per user for the proactive
-- nudge banner.
create index if not exists mh_escalations_by_user_recent
  on public.mh_escalations (user_id, created_at desc);

alter table public.mh_escalations enable row level security;

-- SELECT policy only: authenticated users can read their own escalation
-- count for the proactive banner. NO INSERT/UPDATE/DELETE policy —
-- service_role bypasses RLS and is the only writer (safety/log.ts).
-- Authenticated users cannot fabricate escalation rows.
create policy mh_escalations_select_own on public.mh_escalations for select
  using (user_id = private.requesting_user_id());
