import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// POST /api/snooze
//
// Snoozes a single row (any of the 6 row-bearing surfaces) until a future
// timestamp. The dashboard list hooks filter out rows where
// snoozed_until > now() so the row visibly disappears on next refetch.
//
// source_table is validated against the same set the migration's check
// constraint allows (per-table, but we maintain it here as a JS Set so the
// route returns a precise 400 rather than a generic 500 on a bad value).
//
// We use service_role through makeSupabaseServerClient and add an explicit
// user_id filter — same pattern as feedback + decisions. RLS would block
// browser-direct writes; here we're the trusted server.

export const runtime = "nodejs";

const ALLOWED_SOURCE_TABLES = new Set([
  "emails",
  "slack_messages",
  "calendar_events",
  "notion_pages",
  "contacts",
  "decisions",
]);

type PostBody = {
  source_table?: string;
  source_id?: string;
  snoozed_until?: string;
};

export async function POST(req: NextRequest) {
  const resolved = await resolveUser(req);
  if (!resolved.ok) return resolved.response;
  const { supabaseUserId } = resolved.user;

  let payload: PostBody;
  try {
    payload = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const sourceTable = payload.source_table;
  const sourceId = payload.source_id;
  const snoozedUntil = payload.snoozed_until;

  if (!sourceTable || !ALLOWED_SOURCE_TABLES.has(sourceTable)) {
    return NextResponse.json(
      { error: "invalid_source_table" },
      { status: 400 },
    );
  }
  if (!sourceId || typeof sourceId !== "string") {
    return NextResponse.json({ error: "source_id_required" }, { status: 400 });
  }
  if (!snoozedUntil || typeof snoozedUntil !== "string") {
    return NextResponse.json(
      { error: "snoozed_until_required" },
      { status: 400 },
    );
  }
  const dt = new Date(snoozedUntil);
  if (Number.isNaN(dt.getTime())) {
    return NextResponse.json(
      { error: "invalid_snoozed_until" },
      { status: 400 },
    );
  }
  // Refuse past-snoozes — they'd be filtered back into the visible list
  // on next read, which is just confusing. UI clamps to future values too.
  if (dt.getTime() <= Date.now()) {
    return NextResponse.json(
      { error: "snoozed_until_must_be_future" },
      { status: 400 },
    );
  }

  const supabase = makeSupabaseServerClient();
  const { error } = await supabase
    .from(sourceTable)
    .update({ snoozed_until: dt.toISOString() })
    .eq("id", sourceId)
    .eq("user_id", supabaseUserId);

  if (error) {
    console.error("[snooze/POST] update failed", {
      supabaseUserId,
      sourceTable,
      sourceId,
      message: error.message,
    });
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
