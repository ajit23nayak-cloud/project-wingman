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
