# Convex conventions

These rules exist because we hit the Convex free-tier 1 GB/month bandwidth
ceiling on day 3 of the build. They are bandwidth-discipline rules. Apply them
to every new query, action, and dashboard view going forward.

## 1. List queries are cursor-paginated

Never `.collect()` a list and return it to the client. Use `.paginate()` with
`paginationOptsValidator` and the `usePaginatedQuery` hook on the client. Page
size is 50 unless there's a reason to go smaller.

```ts
// convex/inbox.ts
export const listPaginated = query({
  args: {
    paginationOpts: paginationOptsValidator,
    classification: v.optional(...),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("emails")
      .withIndex("by_userId_classification", (q) => ...)
      .order("desc")
      .paginate(args.paginationOpts);
  },
});
```

```tsx
// dashboard
const { results, status, loadMore } = usePaginatedQuery(
  api.inbox.listPaginated,
  { classification: filter },
  { initialNumItems: 50 },
);
```

If you find yourself writing `.collect()` in a `query`, stop and reach for
`.paginate()` first. `.collect()` belongs in `internalQuery`s consumed by
actions, where the result stays server-side.

## 2. List queries return a slim payload

Map each row to only the fields the UI needs. Drop large or array fields the
list view doesn't render. The current list shape is:

```ts
type EmailListItem = {
  _id: Id<"emails">;
  fromAddress: string;
  subject: string;
  snippet: string;        // truncated to 200 chars server-side
  classification: "urgent" | "important" | "fyi" | "archive" | null;
  classificationReason: string | undefined;
  receivedAt: number;
};
```

Things that are explicitly **not** returned to the list: `threadId`,
`toAddresses` (array), full `snippet` (>200 chars), `gmailMessageId`,
`draftReply`, `classifiedAt`, `processedAt`, `status`, `classificationError`.

If a detail view needs the full row, fetch it on-demand via
`api.inbox.getEmailById` (single doc), not by widening the list query.

## 3. Server-side filtering via the right index

Filter on the database, not in JavaScript after `.collect()`. Add a compound
index when a filter combo would otherwise force a table scan. Today's emails
table has:

- `by_userId` — user-scoped scan (paginated "all")
- `by_userId_classification` — user-scoped + classification bucket (the chips)

If you add a new filter (e.g. by sender domain, by date range), define a new
index for it before writing the query. Never `.filter()` a `.collect()`-ed
list and ship that to the client.

## 4. No reactive list subscription during long-running mutations

When an action like `classifyAllPending` will mutate hundreds of rows in a
loop, the dashboard's reactive list `useQuery`/`usePaginatedQuery` will
re-fire on every batch and stream the full page back to the client each time.
That's how 866 emails × ~10 batch updates × 50-row page can quietly burn a
free-tier month of bandwidth.

Rule: while a long-running write is in flight, drop the reactive list
subscription and observe progress through a small dedicated doc instead.

```tsx
// liveClassifying flips on when the action starts, off when progress clears
const paginated = usePaginatedQuery(
  api.inbox.listPaginated,
  liveClassifying ? "skip" : { classification: filter },
  { initialNumItems: 50 },
);
```

Progress lives on the user doc (`users.classificationProgress`) and is patched
once per batch by the action. The `currentUser` subscription is small (~hundreds
of bytes) and updates ~once per batch — that's the "polled progress doc" the
list is replaced with during the run.

## 5. Server-side admin actions, not browser triggers, for one-off batch jobs

If an action is going to touch the whole table (re-classify, migrate, backfill),
run it from the CLI with `npx convex run` against `--prod`. Reserve the
in-app button for the small "click and watch a few succeed" case.

The CLI run path has no Clerk identity. Any action callable from the CLI must
have an explicit fallback path: either accept a `userId` arg, or — in the
single-user beta — pick the only user in the `users` table and proceed.
Document the fallback with an inline comment so it can be tightened when the
user count grows past 1.
