-- users.google_access_token + google_refresh_token were ported from Convex
-- but Convex never wrote to them — convex/lib/clerkBackend.ts:26 fetches
-- the token fresh from Clerk on every call via getUserOauthAccessToken.
-- The schema comment "Encrypted at the application layer" was aspirational
-- and never built. Dropping the dead columns here so Phase 2 routes can't
-- accidentally read from them or grow a stale-token caching bug.
--
-- If we ever need to cache OAuth tokens for offline jobs (e.g. nightly
-- batch outside Clerk's session window), revisit with proper encryption
-- at that point — a real KMS-backed flow, not a TEXT column.
--
-- Apply via Supabase dashboard → SQL Editor → Run.

alter table users drop column google_access_token;
alter table users drop column google_refresh_token;
