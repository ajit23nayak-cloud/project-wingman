import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// DELETE /api/snooze/[source_table]/[source_id]
//
// Clears a previously-set snoozed_until. The row reappears on the next
// dashboard refetch. Same source_table validation as the POST route.

export const runtime = "nodejs";

const ALLOWED_SOURCE_TABLES = new Set([
  "emails",
  "slack_messages",
  "calendar_events",
  "notion_pages",
  "contacts",
  "decisions",
]);

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ source_table: string; source_id: string }> },
) {
  const { source_table, source_id } = await params;
  if (!ALLOWED_SOURCE_TABLES.has(source_table)) {
    return NextResponse.json(
      { error: "invalid_source_table" },
      { status: 400 },
    );
  }
  if (!source_id) {
    return NextResponse.json({ error: "source_id_required" }, { status: 400 });
  }

  const resolved = await resolveUser(req);
  if (!resolved.ok) return resolved.response;
  const { supabaseUserId } = resolved.user;

  const supabase = makeSupabaseServerClient();
  const { error } = await supabase
    .from(source_table)
    .update({ snoozed_until: null })
    .eq("id", source_id)
    .eq("user_id", supabaseUserId);

  if (error) {
    console.error("[snooze/DELETE] update failed", {
      supabaseUserId,
      source_table,
      source_id,
      message: error.message,
    });
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
