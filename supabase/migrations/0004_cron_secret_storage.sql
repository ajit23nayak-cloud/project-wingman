-- Cron / secret storage pattern. The standard Supabase recommendation
-- (alter database postgres set app.cron_secret = '…' + current_setting()
-- in pg_cron jobs) does not persist on the free tier — the GUC either
-- gets rejected or resets on pooler restart. This migration sets up the
-- table-based alternative that's used everywhere going forward:
--
--   private.config(key, value)         — one row per secret
--   private.get_secret(key) -> text    — STABLE SECURITY DEFINER read
--
-- pg_cron jobs reference secrets via:
--
--   select net.http_post(
--     url := '…',
--     headers := jsonb_build_object(
--       'Authorization',
--       'Bearer ' || (select private.get_secret('cron_secret'))
--     )
--   );
--
-- The actual secret value is inserted out-of-band via the SQL Editor at
-- provisioning time — NEVER committed in a migration. The CRON_SECRET also
-- lives in Vercel env vars; the route handlers validate against env, the
-- pg_cron jobs validate against this table. Both must hold the same value.
--
-- The `private` schema was created in 0002 (for the requesting_user_id
-- helper). This migration assumes it exists.

create table if not exists private.config (
  key text primary key,
  value text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function private.get_secret(secret_key text)
returns text
language sql
stable
security definer
set search_path = private
as $$
  select value from private.config where key = secret_key
$$;

-- Authenticated role does not get EXECUTE — this function only fires from
-- inside pg_cron job definitions (which run as the postgres role) or from
-- explicit grants for specific use cases. Default is locked down so a
-- compromised user token can't lift secrets.
revoke all on function private.get_secret(text) from public;
