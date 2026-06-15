import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// GET /api/decisions
//
// Decision log list, optionally filtered by status. Ordered by
// decision_made_at desc — newest decisions at the top, matching the
// "what did I decide recently" mental model rather than created_at
// (which can drift from the actual decision moment if backfilled).
//
// POST /api/decisions
//
// Create a new decision. The status is derived, not chosen by the caller:
//
//   - 'committed' iff both `decision` and `reasoning` are non-empty strings
//   - 'drafted'  otherwise
//
// This keeps the UI honest — a row is "committed" only when there's a
// recorded choice + recorded reason. A blank-but-saved entry is a draft,
// regardless of what other fields are filled in.
//
// postmortem_due_at defaults to decision_made_at + 30 days; the cron job
// that flips status to 'postmortem_due' compares this against now().

export const runtime = "nodejs";

const ALLOWED_STATUSES = new Set([
  "drafted",
  "committed",
  "postmortem_due",
  "reviewed",
]);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const POSTMORTEM_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type PostBody = {
  title?: string;
  context?: string | null;
  options_considered?: unknown;
  decision?: string | null;
  reasoning?: string | null;
  premortem?: string | null;
  decision_made_at?: string | null;
  postmortem_due_at?: string | null;
  linked_source_kind?: string | null;
  linked_source_id?: string | null;
  tags?: unknown;
};

export async function GET(req: NextRequest) {
  const resolved = await resolveUser(req);
  if (!resolved.ok) return resolved.response;
  const { supabaseUserId } = resolved.user;

  const { searchParams } = new URL(req.url);
  const statusParam = searchParams.get("status");

  const limitRaw = Number.parseInt(searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, MAX_LIMIT)
    : DEFAULT_LIMIT;

  const supabase = makeSupabaseServerClient();
  let query = supabase
    .from("decisions")
    .select("*")
    .eq("user_id", supabaseUserId);

  if (statusParam) {
    if (!ALLOWED_STATUSES.has(statusParam)) {
      return NextResponse.json(
        { error: "invalid_status" },
        { status: 400 },
      );
    }
    query = query.eq("status", statusParam);
  }

  const { data, error } = await query
    .order("decision_made_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[decisions/GET] select failed", {
      supabaseUserId,
      message: error.message,
    });
    return NextResponse.json({ error: "select_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, decisions: data ?? [] });
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

  // Default the decision_made_at to now; postmortem_due_at to +30d from
  // whichever decision_made_at we end up using. Caller can override either.
  const decisionMadeAt = payload.decision_made_at
    ? new Date(payload.decision_made_at)
    : new Date();
  if (Number.isNaN(decisionMadeAt.getTime())) {
    return NextResponse.json(
      { error: "invalid_decision_made_at" },
      { status: 400 },
    );
  }

  let postmortemDueAt: Date;
  if (payload.postmortem_due_at) {
    postmortemDueAt = new Date(payload.postmortem_due_at);
    if (Number.isNaN(postmortemDueAt.getTime())) {
      return NextResponse.json(
        { error: "invalid_postmortem_due_at" },
        { status: 400 },
      );
    }
  } else {
    postmortemDueAt = new Date(
      decisionMadeAt.getTime() + POSTMORTEM_WINDOW_MS,
    );
  }

  // Derived status — committed requires both decision and reasoning to be
  // non-empty. Trimming first so " " doesn't qualify as a real decision.
  const decisionStr =
    typeof payload.decision === "string" ? payload.decision.trim() : "";
  const reasoningStr =
    typeof payload.reasoning === "string" ? payload.reasoning.trim() : "";
  const status =
    decisionStr.length > 0 && reasoningStr.length > 0 ? "committed" : "drafted";

  const row = {
    user_id: supabaseUserId,
    title,
    context: payload.context ?? null,
    options_considered: payload.options_considered ?? null,
    decision: payload.decision ?? null,
    reasoning: payload.reasoning ?? null,
    premortem: payload.premortem ?? null,
    decision_made_at: decisionMadeAt.toISOString(),
    postmortem_due_at: postmortemDueAt.toISOString(),
    status,
    linked_source_kind: payload.linked_source_kind ?? null,
    linked_source_id: payload.linked_source_id ?? null,
    tags: payload.tags ?? null,
  };

  const supabase = makeSupabaseServerClient();
  const { data, error } = await supabase
    .from("decisions")
    .insert(row)
    .select("*")
    .single();

  if (error || !data) {
    console.error("[decisions/POST] insert failed", {
      supabaseUserId,
      message: error?.message,
    });
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, decision: data });
}
