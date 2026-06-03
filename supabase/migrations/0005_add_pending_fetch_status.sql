-- Phase 2 hybrid ingest: status='pending_fetch' rows are stubs created by
-- ingestEmails for the 120 most-recent IDs beyond the first 30 fully-fetched.
-- A cron-driven body-fetch route walks them in 10-at-a-time chunks, fills
-- metadata, and transitions status to 'pending' (ready for classification).
--
-- Required for the stub rows to exist:
--   1. New 'pending_fetch' variant on the email_status enum.
--   2. NULLable from_address / subject / snippet / received_at — these are
--      only known after the metadata fetch. Reads that surface emails to
--      users filter status != 'pending_fetch', so they never see NULLs.
--   3. Partial index on the cron pickup path so the worker can find stubs
--      cheaply (single B-tree lookup per firing).
--
-- Apply via Supabase dashboard → SQL Editor → Run.

alter type email_status add value if not exists 'pending_fetch' before 'pending';

alter table emails alter column from_address drop not null;
alter table emails alter column subject drop not null;
alter table emails alter column snippet drop not null;
alter table emails alter column received_at drop not null;

create index emails_pending_fetch_by_user on emails (user_id)
  where status = 'pending_fetch';
