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

Three production bugs in the 24h window of 2026-06-04 → 2026-06-05 had the
same root cause: declaring a TypeScript shape and then assuming Supabase /
PostgREST returns that shape.

- `claim_pending_fetch_chunk` — code called `.rpc()` against the wrong
  schema; "function exists in migration file" was conflated with "function
  callable from the bare client." Fixed in migration 0008.
- `email_counts` — migration 0009 was authored and committed but never
  applied; the dashboard hit `.rpc('email_counts')` against a function that
  didn't exist in the live DB. Fixed by applying the migration manually.
- `email.drafts` embed — the TS type declared `drafts: T[]` but PostgREST
  returns a single object OR `null` when the foreign key is UNIQUE.
  `email.drafts[0]?.status` crashed at the `[0]` step on null. Fixed in this
  commit.

### Rules

1. **Log before typing.** For every new `supabase.rpc(...)`, every new
   `.from(...).select(...)` with an embedded resource, and every new RPC
   migration, call it once with `console.log(JSON.stringify(data, null, 2))`
   in the dev console (or a one-off test route) and capture the actual
   shape. Write the TS type from what you observed, not what you intended.

2. **Embedded resources: array vs single object.** `select("..., other(field)")`
   returns:
   - a **single object** or `null` when the foreign key from `other` has a
     UNIQUE constraint (one-to-one relation)
   - an **array** otherwise (one-to-many)
   When in doubt, type as the union of both + null and branch in code:
   `const row = Array.isArray(x) ? x[0] : x; row?.field`

3. **Migration files are not proof of application.** Supabase migrations in
   `supabase/migrations/` are manually applied per the header of `0002`.
   After authoring a migration that adds an object the app depends on, verify
   it landed in the live DB before declaring the feature shipped:
   - functions: `select proname from pg_proc where proname = '<fn>'`
   - tables: `\d <table>` (psql) or query `information_schema.tables`
   - columns: `\d <table>` or `information_schema.columns`
   - any object: query `pg_catalog` directly from the SQL Editor
   Add the verification command to the commit message or PR description so a
   reviewer can sanity-check.

### Background

See migration 0008 (schema mismatch), the 2026-06-05 dashboard hotfix
commit (one-to-one embed handling), and the email_counts gap above.
