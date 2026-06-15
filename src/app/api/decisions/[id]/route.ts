import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// GET    /api/decisions/[id] — single decision row
// PATCH  /api/decisions/[id] — partial update (status is enum-validated)
// DELETE /api/decisions/[id] — hard delete (no soft-delete column on this
//                              table per the Phase 3 schema lock)
//
// All three handlers Clerk-gate via resolveUser and filter by user_id on
// the operation. The service-role client bypasses RLS, so explicit user_id
// filtering is what enforces isolation.

export const runtime = "nodejs";

const ALLOWED_STATUSES = new Set([
  "drafted",
  "committed",
  "postmortem_due",
  "reviewed",
]);

// The full allow-list of fields the caller may set via PATCH. Anything not
// listed here (id, user_id, created_at, etc.) is silently dropped.
const PATCH_FIELDS = [
  "title",
  "context",
  "options_considered",
  "decision",
  "reasoning",
  "premortem",
  "postmortem",
  "postmortem_due_at",
  "status",
  "linked_source_kind",
  "linked_source_id",
  "tags",
] as const;

type PatchBody = Partial<Record<(typeof PATCH_FIELDS)[number], unknown>>;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const resolved = await resolveUser(req);
  if (!resolved.ok) return resolved.response;
  const { supabaseUserId } = resolved.user;

  const supabase = makeSupabaseServerClient();
  const { data, error } = await supabase
    .from("decisions")
    .select("*")
    .eq("id", id)
    .eq("user_id", supabaseUserId)
    .maybeSingle();

  if (error) {
    console.error("[decisions/[id]/GET] select failed", {
      id,
      message: error.message,
    });
    return NextResponse.json({ error: "select_failed" }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json(
      { error: "decision_not_found" },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true, decision: data });
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

  const update: Record<string, unknown> = {};
  for (const field of PATCH_FIELDS) {
    if (field in payload) {
      update[field] = payload[field];
    }
  }

  // Validate status enum if the caller is touching it. The DB has a CHECK
  // constraint as backstop, but validating here gives the UI a precise
  // error instead of a generic 500.
  if ("status" in update) {
    const status = update.status;
    if (typeof status !== "string" || !ALLOWED_STATUSES.has(status)) {
      return NextResponse.json(
        { error: "invalid_status" },
        { status: 400 },
      );
    }
  }

  // Validate title is non-empty if provided — same rule as POST.
  if ("title" in update) {
    const t = update.title;
    if (typeof t !== "string" || t.trim().length === 0) {
      return NextResponse.json(
        { error: "title_required" },
        { status: 400 },
      );
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json(
      { error: "no_writable_fields" },
      { status: 400 },
    );
  }

  update.updated_at = new Date().toISOString();

  const supabase = makeSupabaseServerClient();
  const { data, error } = await supabase
    .from("decisions")
    .update(update)
    .eq("id", id)
    .eq("user_id", supabaseUserId)
    .select("*")
    .maybeSingle();

  if (error) {
    console.error("[decisions/[id]/PATCH] update failed", {
      id,
      message: error.message,
    });
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json(
      { error: "decision_not_found" },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true, decision: data });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const resolved = await resolveUser(req);
  if (!resolved.ok) return resolved.response;
  const { supabaseUserId } = resolved.user;

  const supabase = makeSupabaseServerClient();
  const { data, error } = await supabase
    .from("decisions")
    .delete()
    .eq("id", id)
    .eq("user_id", supabaseUserId)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[decisions/[id]/DELETE] delete failed", {
      id,
      message: error.message,
    });
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json(
      { error: "decision_not_found" },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true });
}
