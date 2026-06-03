// Ingest + voice corpus + rate-limit constants. Single source of truth so a
// dial change ripples through ingest, prune, classify, and the cron route
// without missed call sites. Ported from convex/lib/limits.ts and extended
// for the Phase 2 hybrid first-ingest split.

// Hard cap on the active (non-stale) email pool per user. Beyond this,
// oldest-by-received_at rows are flagged archived_stale on next ingest.
export const BACKFILL_EMAIL_CAP = 150;

// Hysteresis: active pool drifts up to CAP + BUFFER before pruning fires.
// Keeps a daily 20-email sync from triggering a prune on every insert.
export const STALE_BUFFER = 25;

// Recency cutoff used by the historical backfill (deprecated for Supabase
// since we start with zero rows). Kept as a constant for future use if we
// ever import historical data.
export const STALE_AGE_DAYS = 14;

// First-sync lookback window for new users. Pull at most CAP messages
// received within this window.
export const INITIAL_LOOKBACK_DAYS = 30;

// Hybrid first-ingest split (Phase 2). The route fetches FIRST_INGEST_FULL
// most-recent emails fully (metadata + snippet) within Vercel's 10s ceiling
// (~3s wall clock), and queues the remaining IDs as status='pending_fetch'
// stubs for the body-fetch cron route to drain.
//
// Math: 30 emails × 3 batches of 10 concurrent messages.get × ~500ms per
// batch = ~1.5s metadata fetch. Plus list (~700ms), insert (~300ms), token
// (~300ms), prune (~200ms), auth (~100ms) ≈ 3.1s. Safe inside 10s with
// cold-start headroom.
export const FIRST_INGEST_FULL = 30;

// Body-fetch cron chunk size. Drives messages.get batches of CHUNK_SIZE
// concurrent calls. Fits Vercel Hobby 10s ceiling: 5 concurrent × 1
// messages.get round-trip (~500-800ms) = ~1s wall clock plus DB write.
//
// pg_cron min interval is 1 minute, so worst-case backfill of 120 stubs
// drains in ceil(120 / 5) = 24 minutes. Acceptable for v1.
export const BODY_FETCH_CHUNK_SIZE = 5;

// Classifier inner-batch parallel-fire (Phase 2 spec — locked at INNER_BATCH=5
// after pacing-vs-pg-cron analysis). 5 parallel Gemini Flash-Lite calls at
// ~2-3s each = ~3s wall clock per chunk + 5s buffer = ~8s, fits 10s ceiling.
//
// Throughput: 5 emails × 60 cron firings/hour = 300 emails/hour. Under
// Gemini free-tier 15 RPM cap when amortized (300/hour = 5 RPM).
//
// Pace math: rpm = INNER_BATCH * 60. Re-derive before changing. Drop to 3
// if Gemini latency exceeds 3s in practice — see rate_limit_math memory.
export const CLASSIFY_INNER_BATCH = 5;
