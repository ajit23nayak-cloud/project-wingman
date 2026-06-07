-- Gmail re-auth flag on users. Set by server-side routes when Clerk's stored
-- Google OAuth grant has expired or been revoked — the 4-5-day-idle pattern
-- that's been a launch blocker since project_oauth_stale_launch_blocker.md.
--
-- Read by the dashboard via /api/dashboard/me to surface a "Reconnect Gmail"
-- banner. Cleared in two places:
--   (i)  explicit POST /api/dashboard/clear-reauth-flag, fired by the
--        /account page's Done button after the user reconnects via Clerk's
--        <UserProfile> Connected Accounts portal.
--   (ii) auto-cleared at the end of the success paths of /api/ingest-emails
--        and /api/cron/fetch-bodies — self-healing if a founder reconnects
--        out-of-band (e.g. revokes + re-authorizes via google.com/permissions
--        without going through Wingman's banner).
--
-- gmail_reauth_needed_at is informational only — surfaces in the banner so
-- the founder sees "Gmail stopped working at X" rather than a bare flag.
-- Not used for any backend logic gate.
--
-- VERIFICATION QUERY (paste output in commit body per CONVENTIONS.md rule 4):
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public'
--     and table_name = 'users'
--     and column_name in ('gmail_reauth_needed', 'gmail_reauth_needed_at');

alter table public.users
  add column if not exists gmail_reauth_needed boolean not null default false,
  add column if not exists gmail_reauth_needed_at timestamptz;
