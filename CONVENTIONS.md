# Conventions

Project-specific rules that aren't enforceable by lint or type-check. When a
new pattern lands here, link the migration / commit / incident that motivated
it so the "why" stays attached to the rule.

## Schema split for SQL functions

Postgres functions live in one of two schemas depending on how they're
**invoked**, not how sensitive they are. Security is enforced by `SECURITY
DEFINER` + `REVOKE ALL FROM PUBLIC` + `service_role`-only access — the schema
name is convention, not protection.

| Call site                                      | Schema    | Why                                                                                                       |
| ---------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------- |
| `supabase.rpc('fn', args)` from a Next.js route | `public`  | supabase-js routes bare `.rpc()` through `public` by default. Anything else 404s.                         |
| Called from inside pg_cron / trigger / SQL body | `private` | These bypass PostgREST entirely (raw SQL inside the DB), so `private` keeps internal helpers off the API surface. |

### Rules

1. **App-code RPCs go in `public`.** Apply `REVOKE ALL ON FUNCTION ... FROM
   PUBLIC` immediately after `CREATE` so anon/authenticated can't reach the
   function through PostgREST. `service_role` bypasses the revoke, so the
   route's service-role client still works.

2. **SQL/cron-only helpers go in `private`.** They're invoked as
   `select private.fn_name(...)` from inside pg_cron job bodies or other
   SECURITY DEFINER functions. They never go through PostgREST, so they
   never need to be in the exposed-schemas list.

3. **Don't add `private` to Supabase API → Exposed Schemas.** Doing so
   defeats the entire reason to use `private`. If you find yourself wanting
   to, the function probably belongs in `public` per rule 1.

4. **When in doubt, grep call sites first.** A function may start as
   cron-only and later get called from app code, or vice versa. The schema
   should follow the **current** call sites, not the original intent.

### Background

This split was codified after the 2026-06-04 incident: migration 0006 put
`claim_pending_fetch_chunk` in `private`, but the Next.js route called it
via `supabase.rpc('claim_pending_fetch_chunk')` — which resolved to `public`
and 404'd on every cron firing. Migration 0008 relocates the function to
`public` and removes the orphaned `private` copy. The split rule above
prevents the same mismatch on the next function.

`private.get_secret()` is the canonical example of a function that stays in
`private`: it's called from inside pg_cron job bodies as
`select private.get_secret('cron_secret')`, never via `.rpc()`. The split
rule keeps it where it belongs.

## Rule: log the actual response shape before declaring a TS type

Four production bugs in the 24h window of 2026-06-04 → 2026-06-05 had the
same root cause: declaring a TypeScript / config shape and then assuming
Supabase, PostgREST, or Vercel honors that shape without verifying.

- `claim_pending_fetch_chunk` — code called `.rpc()` against the wrong
  schema; "function exists in migration file" was conflated with "function
  callable from the bare client." Fixed in migration 0008.
- `cron_secret` — pg_cron's `private.get_secret('cron_secret')` returned
  null because the `private.config` row was never inserted, and Vercel's
  `CRON_SECRET` env var was never set either. Cron jobs 401'd silently for
  a day. Same class: configuration declared in code but not propagated to
  both runtimes that consume it.
- `email_counts` — migration 0009 was authored and committed but never
  applied; the dashboard hit `.rpc('email_counts')` against a function that
  didn't exist in the live DB. Fixed by applying the migration manually
  2026-06-05.
- `email.drafts` embed — the TS type declared `drafts: T[]` but PostgREST
  returns a single object OR `null` when the foreign key is UNIQUE.
  `email.drafts[0]?.status` crashed at the `[0]` step on null. Fixed in
  commit 1af54a9.

### Rules

1. **Log before typing.** For every new `supabase.rpc(...)`, every new
   `.from(...).select(...)` with an embedded resource, and every new RPC
   migration, call it once with `console.log(JSON.stringify(data, null, 2))`
   in the dev console (or a one-off test route) and capture the actual
   shape. Write the TS type from what you observed, not what you intended.

2. **Pin the observed shape as a code comment.** Above every TS type that
   describes a Supabase response, add a 1–3 line comment explaining what
   was observed and (when non-obvious) why. The comment is the proof for
   the next maintainer that the type was derived from data, not invented.
   `src/lib/supabase/hooks.ts` `EmailRow.drafts` is the canonical example —
   the comment captures both the runtime shape and the PostgREST rule that
   produced it.

3. **Embedded resources: array vs single object depends on direction +
   uniqueness.** With `select("..., other(field)")`:
   - Embedding a **parent** (current row's FK points into `other`) → always
     a single object or `null` (many-to-one).
   - Embedding **children** (`other`'s FK points into current row) →
     normally an array, but **a single object or `null` if `other`'s FK
     column has a UNIQUE constraint** (one-to-one).
   When in doubt, type as the union of all three and branch in code:
   `const row = Array.isArray(x) ? x[0] : x; row?.field`

4. **Migration files are not proof of application — paste the verification
   in the commit message.** Supabase migrations in `supabase/migrations/`
   are manually applied per the header of `0002_phase1_full_schema.sql`.
   After authoring a migration that adds an object the app depends on, run
   the matching verification query in the Supabase SQL Editor AND paste
   the output rows into the commit message body so a reviewer can
   sanity-check. The verification is not optional and not deferrable.
   - functions: `select proname, pg_get_function_result(oid) from pg_proc where proname = '<fn>' and pronamespace = 'public'::regnamespace;`
   - tables: `select column_name, data_type from information_schema.columns where table_name = '<table>' and table_schema = 'public';`
   - rows in a config table: `select * from <schema>.<table> where <key> = '<value>';`
   - any object: query `pg_catalog` directly from the SQL Editor.
   The `\d <table>` shortcut from `psql` is NOT available in Supabase SQL
   Editor — use `information_schema` instead.

5. **Two-runtime secrets need a smoke test that hits both.** Any value
   that lives in **both** Vercel env vars AND a Supabase table / config
   row (because pg_cron can't read Vercel env) needs a one-shot smoke
   test exercising both consumers before the feature is called shipped.
   See `supabase/CONVENTIONS.md` → "Cron-triggered routes" for the
   canonical `CRON_SECRET` pattern.

### Background

See migration 0008 (schema mismatch), migration 0009 (function existence
gap), commit 1af54a9 (one-to-one embed handling), and the cron-secret
postmortem in the bug list above.

## Tab coordination protocol

Two Claude agents work on this codebase: **Tab 1** (Claude Code CLI, builds
and deploys) and **Tab 2** (Cowork desktop, strategy and verification).
They coordinate via `coordination/log.md` (a shared append-only message bus
in this repo). This eliminates Ajit having to copy-paste large blocks
between the two tabs.

### Rules for both tabs

1. **Read `coordination/log.md` at the start of every turn.** Skip entries
   you authored. React to the most recent inbound entry from the other tab.

2. **Append (never edit) prior entries.** Add new H2-headed entries at the
   end: `## [YYYY-MM-DD HH:MM UTC | Tab N] Subject`.

3. **Surface `@AJIT:` flags at the top of your response.** When you write
   `@AJIT: <reason>` in a log entry, also surface it at the top of your
   in-chat response so Ajit sees it without having to read the log.

4. **One log entry per meaningful action.** A build outcome, a verification
   result, a queued batch, a blocking question. Don't append for trivial
   activity (reading a file, single grep, etc.).

5. **Ajit's interaction shrinks to** typing `check log` in each tab to
   advance, and responding to `@AJIT:` flags. He should not need to
   paste-block content between tabs anymore.

### Read paths for both tabs on first touch

Both tabs should also auto-read the strategy doc registry (per the
project-level pattern Tab 2's CLAUDE.md alternate): `ROADMAP.md`,
`sprint-strategy.md`, `MH_UI_SPEC.md`, `OAUTH_SUBMISSION_CHEATSHEET.md`,
`CONVENTIONS.md` (this file). Before making any scope, timeline, or
prioritization recommendation, ground in these.

### What goes in the log

- Tab 1: build outcomes (commit SHA + build pass + deploy URL), pushback
  questions before writing code, verification queries from migrations.
- Tab 2: queued batches with locks, browser verification results, spec
  hand-offs, strategic clarifications.
- Either tab: `@AJIT:` flags when blocked.

### Background

Established 2026-06-08 when the Path C v0 push made Ajit's manual
copy-paste routing between tabs unsustainable. The protocol reduces his
intervention from ~500-word paste-blocks per cycle to a 2-word `check
log` trigger per cycle.

## MH surface safety boundary

The chat fallback route in "Help me think" (`/api/mh/chat`) and any future
free-text MH surface must run the safety screen BEFORE the LLM call AND
embed the SAFETY block in the LLM system prompt. Defense in depth — Layer
1 (regex) catches the obvious phrases; Layer 2 (LLM-prompted) catches what
the regex misses (metaphor, non-English, novel framings).

### Contract for new MH free-text surfaces

1. Import `screenForSafety(text)` from `src/lib/mh/safety/screen.ts`. Call
   it on the user's latest message before any LLM call. If `triggered`,
   return the escalation script immediately and `logEscalation(...)` via
   `src/lib/mh/safety/log.ts`. Do NOT call the LLM.

2. Build the system prompt with the `SAFETY BOUNDARY` block. Easiest:
   import `escalationScript(region)` from `safety/resources.ts` and
   interpolate it into your prompt template. The block tells the LLM to
   output the exact escalation script when crisis content is detected.

3. After the LLM responds, check if the response matches the escalation
   opening (`llmOutputIsEscalation` helper or equivalent regex). If yes,
   `logEscalation(..., detectionLayer: 'llm')` so we can measure Layer 1
   vs Layer 2 coverage in v1.

4. Pass `region` from `regionFromClaims(sessionClaims)` (Clerk timezone
   default IN). Never let the user pick their own region — that would
   route an Indian user typing crisis content to US resources, which is
   slower help.

5. NEVER log the user's message content. The `mh_escalations` table has
   no content column on purpose. PostHog events get metadata only.

### Why it's mandatory and not optional

Wingman is a coaching tool, not a crisis service. The safety boundary is
the contract with users: when they cross from coaching-shaped concerns
into crisis-shaped concerns, we hand off to professionals. Any free-text
LLM surface that bypasses the safety boundary breaks that contract.

Established 2026-06-09 (MH Commit F).

## Third-party OAuth: token at rest (Slack deviation)

The general rule for third-party OAuth tokens in Wingman is "follow the Clerk
pattern — never store, fetch fresh per request" (see Gmail integration in
`src/lib/clerk.ts` → `getGoogleAccessToken`). This rule was codified after
migration 0003 dropped unused token columns from Phase 1.

**Slack is the exception.** Slack OAuth is not a Clerk-managed connector, so
Wingman has no way to fetch fresh bot tokens at request time. We store the
bot token at rest in `slack_credentials.bot_token` (separate table from
`slack_workspaces` per blast-radius separation).

### Storage rules for Slack (v0)

1. **Bot tokens live in `slack_credentials`, never `slack_workspaces`.** The
   credentials table has RLS enabled with NO policies — service_role bypass
   only. Even a misconfigured RLS on `slack_workspaces` cannot expose the
   token because it isn't there.

2. **Service-role code paths only.** The only callers that read
   `slack_credentials.bot_token` are server-side: the OAuth callback (insert)
   and the `ingest-slack` cron (read). Never expose the credentials table
   through a `.from('slack_credentials')` call in browser code or a hook.

3. **On `SlackAuthError`** (token revoked / expired / invalid): set
   `slack_workspaces.status = 'disconnected'` and `disconnected_at = now()`.
   Cron skips disconnected workspaces. The user reconnects via the same
   /settings → Connect Slack flow; the OAuth callback upserts the
   credentials row with the new token.

### v1 hardening

This is a v0 deviation, not a permanent posture. v1 hardening tracks:

- Enable `pgsodium` extension; encrypt `bot_token` column with
  `crypto_aead_det_encrypt`. Cron pays a per-row decrypt cost but the
  15-min cadence makes it negligible.
- Add a KEK (key-encryption-key) row in `private.config` for rotation.

### Why we picked separate table over plaintext on `slack_workspaces`

Three options were considered before locking the separate-table approach:

- (i) Plaintext column on `slack_workspaces` with RLS protection: simplest,
  but a service-role key leak compromises all tokens, and any future
  misconfigured RLS on the workspace row exposes the token.
- (ii) Column-level encryption via `pgsodium`: right end state but
  pgsodium readiness verify alone burns the v0 day budget.
- (iii) Separate `slack_credentials` table, no RLS policies: chosen.
  Blast-radius separation without a new crypto dep.

Tracked in Tab 2's 2026-06-11 07:00 UTC lock. Established 2026-06-11
(Slack Commit 3).
