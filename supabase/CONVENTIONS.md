# Supabase conventions

These rules exist because Supabase has two ways to access the database — the
**anon key with a Clerk JWT** (RLS scopes the request to the signed-in user)
and the **service_role key** (bypasses every RLS policy in the project). One
typo in the wrong direction leaks the entire users table. The four rules
below draw the line so no mistake is silent.

Adopted at the start of Phase 2 of the Convex→Supabase migration, after the
`/poc/rls` POC proved Clerk JWT → RLS isolation works.

## 1. service_role clients live in exactly one place

The only constructor of a service_role-keyed Supabase client is
`makeSupabaseServerClient` in `src/lib/supabase/server.ts`. That file
imports `"server-only"`, which makes Next.js bundle-fail if it's ever pulled
into a client component.

`src/lib/supabase/server.ts` may be imported only from `src/app/api/**` (or
server actions / route handlers, when we add them) — or from a sibling lib
helper that itself imports `"server-only"` and is only ever imported from
those same server contexts (e.g. `src/lib/auth/resolveUser.ts`). The
runtime guarantee is the `"server-only"` chain, not the literal directory.
If you find yourself importing it from a client file, stop — the right
shape is an API route that the client `fetch`es.

```ts
// ✅ src/app/api/admin/something/route.ts
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// ❌ src/app/dashboard/Something.tsx
import { makeSupabaseServerClient } from "@/lib/supabase/server";
//      ^ would explode at build time thanks to "server-only" — that's the safety net.
```

## 2. service_role reads "on behalf of a user" filter user_id in SQL

service_role has no `auth.jwt()` context, so RLS doesn't fire. If you write
`select * from emails` from a service_role client, you get **every user's**
emails. Always filter by the resolved `user_id` explicitly:

```ts
// Resolve the request's Clerk session → users.id once, up front
const { userId: clerkUserId } = await auth(); // Clerk
const { data: userRow } = await supabase
  .from("users")
  .select("id")
  .eq("clerk_user_id", clerkUserId)
  .single();
if (!userRow) return NextResponse.json({ error: "no user" }, { status: 404 });

// Every subsequent read on behalf of this user includes the filter
const { data: emails } = await supabase
  .from("emails")
  .select("*")
  .eq("user_id", userRow.id)         // ← load-bearing line
  .order("received_at", { ascending: false });
```

The "no auth context → no RLS → leak" failure mode is silent: tests pass,
no error, the query just returns more than it should. Eyeball every
service_role read for an explicit `.eq("user_id", …)` before merging.

The exception is cron / admin batch jobs that legitimately scan across
users (e.g. nightly cleanup) — those don't need the filter, but they need
a top-of-file comment explaining why and an `auth(): CRON_SECRET` gate.

## 3. service_role writes set user_id from the Clerk session, never from the body

A POST handler that takes `{ user_id, … }` from the request body and writes
it lets any caller forge ownership. The `user_id` must come from
`ctx.auth.getUserIdentity()` (Clerk) followed by the users-table lookup —
not from a body field, query param, or header.

```ts
// ❌ DON'T
const { user_id, body } = await req.json();
await supabase.from("drafts").insert({ user_id, body, ... });

// ✅ DO
const { userId: clerkUserId } = await auth();
const { data: userRow } = await supabase
  .from("users").select("id").eq("clerk_user_id", clerkUserId).single();
await supabase.from("drafts").insert({ user_id: userRow.id, body, ... });
```

Same rule applies to `update` / `upsert` / `delete` — the `user_id` you
match on must come from the resolved Clerk session, not the request.

## 4. Never log service_role-fetched data verbatim

`console.log(rows)` after a service_role read can ship full email bodies,
draft texts, OAuth metadata, and Clerk user IDs to Vercel logs (and from
there to anyone with project access, plus any analytics tap we add). Logs
are retained, indexed, and queryable — treat them as a public surface.

Before logging, sanitize: keep counts, IDs, and timing; drop bodies,
addresses, and any free-text user content.

```ts
// ❌ DON'T
console.log("[ingest] fetched", emails);

// ✅ DO
console.log("[ingest] fetched", {
  count: emails.length,
  firstReceivedAt: emails[0]?.received_at,
  lastReceivedAt: emails[emails.length - 1]?.received_at,
});
```

Same goes for any structured-logging sink (PostHog, Sentry, etc.). If you
need a row in a log for debugging, paste its `id` — not its content.

---

## Cron-triggered routes: CRON_SECRET pattern

pg_cron calls our API routes via `net.http_post`. Anything reachable that
way is also reachable by any internet attacker who guesses the URL. Every
cron route gates on a shared secret:

```ts
// src/app/api/cron/<job>/route.ts
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // … real work
}
```

The pg_cron job sends the same header via `net.http_post`:

```sql
select cron.schedule(
  'classify-chunk',
  '* * * * *',
  $$ select net.http_post(
       url := 'https://wingman.vercel.app/api/cron/classify-chunk',
       headers := jsonb_build_object(
         'Authorization',
         'Bearer ' || (select private.get_secret('cron_secret'))
       )
     ) $$
);
```

The secret is stored in `private.config` (one row per secret, keyed by
name) and read through the `private.get_secret(key)` SECURITY DEFINER
helper — both set up in `0004_cron_secret_storage.sql`. The standard
Supabase recommendation of `alter database postgres set app.cron_secret`
+ `current_setting('app.cron_secret')` was tried and **does not persist
on the free tier**, so don't reach for it.

Same value also goes into Vercel env vars as `CRON_SECRET` so the route
can validate. Two places, one secret, no `alter database`.

No cron route ships before `CRON_SECRET` is wired in both places:
- `private.config` row `key='cron_secret'` (Supabase SQL Editor, one-off)
- `CRON_SECRET` env var (Vercel dashboard, all 3 environments)
