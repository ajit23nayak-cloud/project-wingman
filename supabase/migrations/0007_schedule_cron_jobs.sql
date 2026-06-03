-- pg_cron schedule for the body-fetch worker. Apply AFTER:
--   1. Vercel has deployed handler #2 (so the URL is live).
--   2. private.config row key='cron_base_url' is inserted with the Vercel
--      production URL (no trailing slash). See "one-off setup" below.
--   3. private.config row key='cron_secret' already exists (from 0004).
--
-- Idempotent: cron.unschedule runs only if a job by the same name exists,
-- so re-running the migration cleanly replaces the schedule. This means we
-- can tune cadence by editing the cron expression here and re-applying.
--
-- Cadence: '* * * * *' = every minute. With BODY_FETCH_CHUNK_SIZE=5, the
-- queue drains at 300 stubs/hour. A first-ingest backlog of 120 takes ~24
-- minutes to drain end-to-end.

-- One-off setup the operator runs ONCE in the SQL Editor, separately from
-- this migration (NOT committed because it embeds the deployment URL):
--
--   insert into private.config (key, value)
--   values ('cron_base_url', 'https://<your-vercel-domain>')
--   on conflict (key) do update set value = excluded.value, updated_at = now();
--
-- If the Vercel domain changes (custom domain, branch deploy, project
-- rename), update the row and re-run this migration to refresh the schedule
-- (the URL is captured into the schedule body at cron.schedule time).

do $$
begin
  if exists (select 1 from cron.job where jobname = 'fetch-bodies') then
    perform cron.unschedule('fetch-bodies');
  end if;
end $$;

select cron.schedule(
  'fetch-bodies',
  '* * * * *',
  $cron$
    select net.http_post(
      url := (select private.get_secret('cron_base_url')) || '/api/cron/fetch-bodies',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || (select private.get_secret('cron_secret')),
        'Content-Type',
        'application/json'
      )
    )
  $cron$
);
