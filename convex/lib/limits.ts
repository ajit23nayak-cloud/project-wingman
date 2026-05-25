// Day 7 email-cap constants. Centralised so a single dial change ripples
// through ingestion, auto-prune, and the backfill migration.

// Hard cap on the active (non-stale) email pool per user. Beyond this,
// oldest-by-receivedAt rows are flagged archived_stale on next ingest.
export const BACKFILL_EMAIL_CAP = 150;

// Hysteresis around the cap. Active pool can drift up to CAP + BUFFER before
// pruning kicks in, so a daily sync of ~20 new emails doesn't trigger a
// prune on every insert.
export const STALE_BUFFER = 25;

// Recency cutoff for the backfill migration. Rows older than this go stale
// even if they fall within the most-recent-CAP window. The AND of "top CAP"
// and "newer than this" defines the active set.
export const STALE_AGE_DAYS = 14;

// First-sync lookback window for new users. Pull at most CAP messages from
// the last 30 days, whichever is fewer.
export const INITIAL_LOOKBACK_DAYS = 30;
