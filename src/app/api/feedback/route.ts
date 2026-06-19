import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// GET /api/feedback
//
// In-dashboard feedback list. Three query modes:
//   1. status=open|addressed|dismissed — single-status filter
//   2. status=all (or omitted) — every status, ordered by created_at desc
//   3. source_table+source_id — scope to a specific dashboard row, used by
//      the orange-dot indicator hook
//
// Returns `{ ok, notes: FeedbackNote[] }`. Ordering is created_at desc —
// newest at the top, matching the sidebar mental model. The service-role
// client bypasses RLS, so the explicit .eq('user_id', supabaseUserId)
// filter is what enforces isolation. Same pattern as decisions.
//
// POST /api/feedback
//
// Create a new note. `title` is required; everything else is optional and
// nullable. `source_table` is enum-validated against the same set as the
// DB check constraint so the UI gets a precise 400 rather than a generic
// 500 from a constraint violation.

export const runtime = "nodejs";

const ALLOWED_STATUSES = new Set(["open", "addressed", "dismissed"]);
const ALLOWED_SOURCE_TABLES = new Set([
  "emails",
  "slack_messages",
  "notion_pages",
  "calendar_events",
  "contacts",
  "decisions",
  "dashboard",
  "mh_banner",
]);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_BODY_LENGTH = 1000;

type PostBody = {
  title?: string;
  body?: string | null;
  dashboard_section?: string | null;
  source_table?: string | null;
  source_id?: string | null;
};

export async function GET(req: NextRequest) {
  const resolved = await resolveUser(req);
  if (!resolved.ok) return resolved.response;
  const { supabaseUserId } = resolved.user;

  const { searchParams } = new URL(req.url);
  const statusParam = searchParams.get("status");
  const sourceTableParam = searchParams.get("source_table");
  const sourceIdParam = searchParams.get("source_id");

  const limitRaw = Number.parseInt(searchParams.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, MAX_LIMIT)
      : DEFAULT_LIMIT;

  const supabase = makeSupabaseServerClient();
  let query = supabase
    .from("feedback_notes")
    .select("*")
    .eq("user_id", supabaseUserId);

  if (statusParam && statusParam !== "all") {
    if (!ALLOWED_STATUSES.has(statusParam)) {
      return NextResponse.json({ error: "invalid_status" }, { status: 400 });
    }
    query = query.eq("status", statusParam);
  }

  // source_table and source_id are XOR-invalid: caller must supply both or
  // neither. Supplying just one means the partial index
  // `feedback_notes_by_source` can't be used and the semantics are unclear.
  if ((sourceTableParam == null) !== (sourceIdParam == null)) {
    return NextResponse.json(
      { error: "source_table_and_source_id_required_together" },
      { status: 400 },
    );
  }

  if (sourceTableParam && sourceIdParam) {
    if (!ALLOWED_SOURCE_TABLES.has(sourceTableParam)) {
      return NextResponse.json(
        { error: "invalid_source_table" },
        { status: 400 },
      );
    }
    query = query
      .eq("source_table", sourceTableParam)
      .eq("source_id", sourceIdParam);
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[feedback/GET] select failed", {
      supabaseUserId,
      message: error.message,
    });
    return NextResponse.json({ error: "select_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, notes: data ?? [] });
}

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

  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (!title) {
    return NextResponse.json({ error: "title_required" }, { status: 400 });
  }

  if (
    payload.source_table != null &&
    !ALLOWED_SOURCE_TABLES.has(payload.source_table)
  ) {
    return NextResponse.json(
      { error: "invalid_source_table" },
      { status: 400 },
    );
  }

  // Body length cap — matches the DB CHECK constraint. We validate here so
  // callers get a precise 400 instead of a 500 from the constraint trip.
  if (
    typeof payload.body === "string" &&
    payload.body.length > MAX_BODY_LENGTH
  ) {
    return NextResponse.json({ error: "body_too_long" }, { status: 400 });
  }

  const row = {
    user_id: supabaseUserId,
    title,
    body: payload.body ?? null,
    dashboard_section: payload.dashboard_section ?? null,
    source_table: payload.source_table ?? null,
    source_id: payload.source_id ?? null,
  };

  const supabase = makeSupabaseServerClient();
  const { data, error } = await supabase
    .from("feedback_notes")
    .insert(row)
    .select("*")
    .single();

  if (error || !data) {
    console.error("[feedback/POST] insert failed", {
      supabaseUserId,
      message: error?.message,
    });
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, note: data });
}
