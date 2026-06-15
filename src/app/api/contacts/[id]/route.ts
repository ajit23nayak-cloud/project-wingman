import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// GET /api/contacts/[id]
//
// Single-contact detail with a unified "recent interactions" feed stitched
// across all three sources we ingest — emails, Slack messages, and calendar
// events. Each source query is independent and bounded to last-10; we sort
// the merged stream by recency and trim to top-30 so the UI gets a single
// flat list ready to render without further client work.
//
// Email match strategy: from_address ILIKE '%<email>%' OR exact equality OR
// the contact's email appears in to_addresses. The ILIKE covers cases where
// the address is wrapped in a display-name format ("Jane Doe <jane@x.com>")
// that some senders emit; the exact match keeps the indexed path hot for
// the common case.
//
// PATCH /api/contacts/[id]
//
// Only the three manual fields (manual_notes, manual_tags, archived) are
// writable through this endpoint. Aggregated columns like last_seen_at and
// total_interactions_lifetime are owned by the roll-up job — we drop any
// caller attempt to set them silently rather than 400 to keep the UI code
// simple (it can send a partial object without curating).

export const runtime = "nodejs";

type PatchBody = {
  manual_notes?: string | null;
  manual_tags?: unknown;
  archived?: boolean;
};

type Interaction = {
  kind: "email" | "slack" | "calendar";
  id: string;
  // Sort key — milliseconds since epoch. Not returned to caller; used only
  // for the merge sort below.
  _sortMs: number;
  [extra: string]: unknown;
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const resolved = await resolveUser(req);
  if (!resolved.ok) return resolved.response;
  const { supabaseUserId } = resolved.user;

  const supabase = makeSupabaseServerClient();

  const { data: contact, error: contactErr } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", id)
    .eq("user_id", supabaseUserId)
    .maybeSingle();

  if (contactErr) {
    console.error("[contacts/[id]/GET] contact select failed", {
      id,
      message: contactErr.message,
    });
    return NextResponse.json({ error: "select_failed" }, { status: 500 });
  }
  if (!contact) {
    return NextResponse.json(
      { error: "contact_not_found" },
      { status: 404 },
    );
  }

  const email: string | null = contact.primary_email ?? null;
  const slackUserId: string | null = contact.primary_slack_user_id ?? null;

  // Fire the three source queries in parallel. Each is bounded to 10 rows
  // and scoped to user_id; we tolerate partial failure (log + drop) so a
  // missing index or table outage in one source doesn't 500 the whole page.
  const interactions: Interaction[] = [];

  const promises: Promise<void>[] = [];

  if (email) {
    promises.push(
      (async () => {
        // Two issues with the original or()-filter approach (caught in
        // review B1#1):
        //   1. PostgREST or() grammar uses comma/period/braces as separators
        //      — an email containing `,` `(` `)` `"` `}` etc. could break
        //      the parser or inject a sibling filter.
        //   2. ILIKE `%email%` substring match would match
        //      "foo@bar.com.attacker.com" when contact email is "foo@bar.com"
        //      — unintended overmatch.
        // Fix: use TWO separate queries with EXACT matches (PostgREST eq
        // and array-contains both safely parameterize values). Cost is one
        // extra round trip per contact-detail render; the query plans use
        // the (user_id, from_address) index and the to_addresses GIN
        // respectively. Merge the results client-side, dedupe on id, limit
        // 10 total. emails.from_address stores normalized "Name <email>" so
        // we still need a `like` for the angle-bracket form, but anchored
        // (not substring).
        const fromAddrLike = `%<${email}>`;
        const [fromRes, toRes] = await Promise.all([
          supabase
            .from("emails")
            .select(
              "id, subject, snippet, received_at, classification, from_address, to_addresses",
            )
            .eq("user_id", supabaseUserId)
            .or(`from_address.eq.${email},from_address.ilike.${fromAddrLike}`)
            .order("received_at", { ascending: false })
            .limit(10),
          supabase
            .from("emails")
            .select(
              "id, subject, snippet, received_at, classification, from_address, to_addresses",
            )
            .eq("user_id", supabaseUserId)
            .contains("to_addresses", [email])
            .order("received_at", { ascending: false })
            .limit(10),
        ]);
        const error = fromRes.error ?? toRes.error;
        // Merge + dedupe by id, sort by received_at desc, cap at 10.
        const seen = new Set<string>();
        const merged: typeof fromRes.data = [];
        for (const row of [...(fromRes.data ?? []), ...(toRes.data ?? [])]) {
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          merged.push(row);
        }
        merged.sort(
          (a, b) =>
            Number((b.received_at as number | null) ?? 0) -
            Number((a.received_at as number | null) ?? 0),
        );
        const data = merged.slice(0, 10);
        if (error) {
          console.warn("[contacts/[id]/GET] emails select failed", {
            id,
            message: error.message,
          });
          return;
        }
        for (const row of data ?? []) {
          const receivedAt = row.received_at as string | number | null;
          const sortMs = receivedAt
            ? typeof receivedAt === "number"
              ? receivedAt
              : new Date(receivedAt).getTime()
            : 0;
          interactions.push({
            kind: "email",
            id: row.id,
            subject: row.subject,
            snippet: row.snippet,
            received_at: row.received_at,
            classification: row.classification,
            link: `/email/${row.id}`,
            _sortMs: sortMs,
          });
        }
      })(),
    );
  }

  if (slackUserId) {
    promises.push(
      (async () => {
        const { data, error } = await supabase
          .from("slack_messages")
          .select("id, text, received_at, classification")
          .eq("user_id", supabaseUserId)
          .eq("sender_id", slackUserId)
          .order("received_at", { ascending: false })
          .limit(10);
        if (error) {
          console.warn("[contacts/[id]/GET] slack select failed", {
            id,
            message: error.message,
          });
          return;
        }
        for (const row of data ?? []) {
          const receivedAt = row.received_at as string | number | null;
          const sortMs = receivedAt
            ? typeof receivedAt === "number"
              ? receivedAt
              : new Date(receivedAt).getTime()
            : 0;
          interactions.push({
            kind: "slack",
            id: row.id,
            text: row.text,
            received_at: row.received_at,
            classification: row.classification,
            _sortMs: sortMs,
          });
        }
      })(),
    );
  }

  if (email) {
    promises.push(
      (async () => {
        // attendees is a jsonb array of {email, responseStatus, ...}. The
        // @> containment operator finds rows where the array contains an
        // object with the given email.
        const { data, error } = await supabase
          .from("calendar_events")
          .select("id, title, start_at, end_at, prep_priority")
          .eq("user_id", supabaseUserId)
          .contains("attendees", [{ email }])
          .order("start_at", { ascending: false })
          .limit(10);
        if (error) {
          console.warn("[contacts/[id]/GET] calendar select failed", {
            id,
            message: error.message,
          });
          return;
        }
        for (const row of data ?? []) {
          const startAt = row.start_at as string | number | null;
          const sortMs = startAt
            ? typeof startAt === "number"
              ? startAt
              : new Date(startAt).getTime()
            : 0;
          interactions.push({
            kind: "calendar",
            id: row.id,
            title: row.title,
            start_at: row.start_at,
            end_at: row.end_at,
            prep_priority: row.prep_priority,
            _sortMs: sortMs,
          });
        }
      })(),
    );
  }

  await Promise.all(promises);

  // Merge-sort across sources by recency, drop the private _sortMs, trim
  // to top-30. The 30-cap matches the spec; UI shows recent activity, not
  // full history.
  interactions.sort((a, b) => b._sortMs - a._sortMs);
  const recent_interactions = interactions.slice(0, 30).map((row) => {
    const { _sortMs: _omit, ...rest } = row;
    return rest;
  });

  return NextResponse.json({
    ok: true,
    contact,
    recent_interactions,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const resolved = await resolveUser(req);
  if (!resolved.ok) return resolved.response;
  const { supabaseUserId } = resolved.user;

  let payload: PatchBody;
  try {
    payload = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Allow-list the three writable fields. Anything else in the body is
  // silently dropped — see the route header comment for the rationale.
  const update: Record<string, unknown> = {};
  if ("manual_notes" in payload) update.manual_notes = payload.manual_notes;
  if ("manual_tags" in payload) update.manual_tags = payload.manual_tags;
  if ("archived" in payload) {
    if (typeof payload.archived !== "boolean") {
      return NextResponse.json(
        { error: "archived_must_be_boolean" },
        { status: 400 },
      );
    }
    update.archived = payload.archived;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json(
      { error: "no_writable_fields" },
      { status: 400 },
    );
  }

  update.updated_at = new Date().toISOString();

  const supabase = makeSupabaseServerClient();
  const { data: row, error } = await supabase
    .from("contacts")
    .update(update)
    .eq("id", id)
    .eq("user_id", supabaseUserId)
    .select("*")
    .maybeSingle();

  if (error) {
    console.error("[contacts/[id]/PATCH] update failed", {
      id,
      message: error.message,
    });
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json(
      { error: "contact_not_found" },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true, contact: row });
}
