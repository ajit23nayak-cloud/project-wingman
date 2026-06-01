-- Day 9 POC migration: users table + RLS only.
-- Scope: prove Clerk JWT -> Supabase RLS row-isolation works before porting
-- the full schema. If POC passes, the same policy pattern applies to emails,
-- voice_samples, drafts, etc. in 0002_phase1_full_schema.sql.
--
-- Apply via Supabase dashboard -> SQL Editor -> Run.

create table users (
  id uuid primary key default gen_random_uuid(),
  clerk_user_id text not null unique,
  email text not null,
  google_access_token text,
  google_refresh_token text,
  paid_tier boolean not null default false,
  paid_tier_expires_at bigint,
  last_ingested_at bigint,
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);

create index users_clerk_user_id_idx on users (clerk_user_id);

alter table users enable row level security;

-- Default deny: with RLS enabled and no matching policy, queries return 0 rows
-- (selects) or fail (writes). Policies below carve allow-paths only for
-- own-row access keyed on the JWT sub claim (Clerk user ID).

create policy users_select_own
  on users for select
  using (clerk_user_id = auth.jwt() ->> 'sub');

create policy users_insert_own
  on users for insert
  with check (clerk_user_id = auth.jwt() ->> 'sub');

create policy users_update_own
  on users for update
  using (clerk_user_id = auth.jwt() ->> 'sub')
  with check (clerk_user_id = auth.jwt() ->> 'sub');
