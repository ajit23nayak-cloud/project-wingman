-- Phase 4 — OKR layer reading from Notion pages.
--
-- Adds three columns to notion_pages so the existing Notion ingest + classify
-- stack can ALSO detect & extract OKR structure (Objectives + Key Results)
-- from pages that happen to be OKR docs. OKR-ness is ORTHOGONAL to attention
-- classification: a page can be both classification='important' AND
-- is_okr_page=true. The existing 4-bucket classification stays as-is per
-- Tab 2's Path B lock (06:25 + 11:05 UTC entries).
--
-- Re-extraction policy lives in the code: classify-pending re-runs the
-- detect+extract steps only when okr_extracted_at IS NULL OR
-- last_edited_at > okr_extracted_at. Two columns wired together to keep
-- LLM cost bounded per page edit.
--
-- VERIFICATION QUERIES (paste output in commit body per CONVENTIONS rule 4):
--   -- columns exist with correct nullability
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public'
--     and table_name = 'notion_pages'
--     and column_name in ('is_okr_page', 'okr_structured', 'okr_extracted_at');
--
--   -- partial index exists on the dashboard hot-read pattern
--   select indexname, indexdef from pg_indexes
--   where schemaname = 'public'
--     and indexname = 'notion_pages_okr_by_user_edited';
--
--   -- no OKR pages yet (expected immediately post-migration; populates as
--   -- classify-pending tick processes Notion rows)
--   select count(*) from notion_pages where is_okr_page = true;

alter table public.notion_pages
  add column if not exists is_okr_page boolean,
  add column if not exists okr_structured jsonb,
  add column if not exists okr_extracted_at timestamptz;

-- Hot-read pattern: dashboard "OKR Tracker" surface scans for OKR pages
-- ordered by last_edited_at. Partial index keeps the scan tight as
-- non-OKR pages accumulate (most Notion pages will NOT be OKR pages).
create index if not exists notion_pages_okr_by_user_edited
  on public.notion_pages (user_id, last_edited_at desc)
  where is_okr_page = true and archived_stale = false;
