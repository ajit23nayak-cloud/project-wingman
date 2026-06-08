import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// PATCH /api/drafts/[id]   — update body (inline edit)
// DELETE /api/drafts/[id]  — the Skip path (delete the draft row entirely;
//                            email row stays, ready for re-generate)
//
// Both gated by resolveUser (Clerk session or CRON_SECRET). Ownership
// verified by `.eq("user_id", supabaseUserId)` on the update/delete — RLS
// would also catch any cross-user attempt, but we filter explicitly because
// the service-role client bypasses RLS.
//
// Sent drafts (status='sent') are read-only history — PATCH and DELETE
// both refuse them. The dashboard list reads drafts(status) and renders
// the ✓ chip for sent rows; we don't want to retroactively edit/delete
// those.

export const runtime = "nodejs";

type PatchBody = { body?: string };

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const result = await resolveUser(req);
  if (!result.ok) return result.response;
  const { supabaseUserId } = result.user;

  let payload: PatchBody;
  try {
    payload = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof payload.body !== "string" || payload.body.length === 0) {
    return NextResponse.json(
      { error: "body_required" },
      { status: 400 },
    );
  }

  const supabase = makeSupabaseServerClient();

  // Reject edits on sent drafts. One query gates + updates.
  const { data: row, error } = await supabase
    .from("drafts")
    .update({ body: payload.body, edited_at: Date.now() })
    .eq("id", id)
    .eq("user_id", supabaseUserId)
    .neq("status", "sent")
    .select("id, body, edited_at, status")
    .maybeSingle();
  if (error) {
    console.error("[drafts/PATCH] update failed", {
      id,
      message: error.message,
    });
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }
  if (!row) {
    // Either the draft doesn't exist for this user OR it's already sent.
    // We don't distinguish (avoids leaking which case it is to a malicious
    // caller). 404 is the right code for both.
    return NextResponse.json(
      { error: "not_found_or_immutable" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, draft: row });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const result = await resolveUser(req);
  if (!result.ok) return result.response;
  const { supabaseUserId } = result.user;

  const supabase = makeSupabaseServerClient();

  // Same status='sent' guard as PATCH — Skip means "I don't want to reply,
  // clear the draft." Already-sent replies are historical record.
  const { data: row, error } = await supabase
    .from("drafts")
    .delete()
    .eq("id", id)
    .eq("user_id", supabaseUserId)
    .neq("status", "sent")
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[drafts/DELETE] delete failed", {
      id,
      message: error.message,
    });
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json(
      { error: "not_found_or_immutable" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
