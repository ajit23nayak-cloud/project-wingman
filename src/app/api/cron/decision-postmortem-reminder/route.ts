import { NextRequest, NextResponse } from "next/server";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// POST /api/cron/decision-postmortem-reminder
//
// Daily sweep at 09:00 UTC (registered by migration 0022). Finds decisions
// whose user-set postmortem_due_at has passed, no postmortem text has been
// written yet, and either we've never reminded the user or we last
// reminded > 24h ago. Flips them to status='postmortem_due' and stamps
// postmortem_reminded_at = now().
//
// Single-user v0 — no per-user loop is needed. One UPDATE statement
// covers all overdue decisions across all users; the surface that reads
// these (the dashboard) is per-user via RLS so we don't have a fan-out
// problem at the cron layer.
//
// Idempotency: the WHERE clause requires
// `(postmortem_reminded_at IS NULL OR postmortem_reminded_at < now - 24h)`.
// A re-fire 10 minutes after this one would find zero matching rows
// (every overdue decision was just reminded), so the cron is safe to
// re-trigger without double-flipping or double-stamping.
//
// Status transitions handled here:
//   committed → postmortem_due  (first time we notice it's overdue)
//   postmortem_due → postmortem_due  (re-reminder after 24h+ without
//                                     a postmortem being filled in — the
//                                     user is dragging their feet; bump
//                                     the timestamp so the UI can show
//                                     "still overdue, last reminded X
//                                     hours ago").
//
// We do NOT touch 'reviewed' (postmortem already filled — done) or
// 'drafted' (user is mid-capture; no commitment yet, so no postmortem
// expectation).

export const runtime = "nodejs";

type DecisionRow = {
  id: string;
  user_id: string;
  status: string;
};

export async function POST(req: NextRequest) {
  // --- Auth ----------------------------------------------------------------
  const expected = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!expected || authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = makeSupabaseServerClient();
  const startedAt = Date.now();

  // --- Find overdue decisions needing a reminder --------------------------
  // SELECT-then-UPDATE pattern (rather than a single UPDATE...RETURNING)
  // because postgrest's filter DSL doesn't compose OR-across-different-
  // columns cleanly with .update(). The two-step keeps the WHERE
  // expressible in postgrest .or() syntax and gives us the matched id list
  // to UPDATE in a single round-trip.
  //
  // WHERE conditions:
  //   - status IN ('committed','postmortem_due')      — only commitments
  //                                                     (drafts excluded,
  //                                                     reviewed excluded)
  //   - postmortem_due_at IS NOT NULL AND <= now()    — overdue
  //   - postmortem IS NULL                            — user hasn't filled in
  //   - (postmortem_reminded_at IS NULL
  //      OR postmortem_reminded_at < now() - 24h)     — debounce: no
  //                                                     reminder in last 24h
  const nowIso = new Date(startedAt).toISOString();
  const debounceCutoffIso = new Date(startedAt - 24 * 60 * 60 * 1000).toISOString();

  const { data: candidates, error: selErr } = await supabase
    .from("decisions")
    .select("id, user_id, status")
    .in("status", ["committed", "postmortem_due"])
    .not("postmortem_due_at", "is", null)
    .lte("postmortem_due_at", nowIso)
    .is("postmortem", null)
    .or(`postmortem_reminded_at.is.null,postmortem_reminded_at.lt.${debounceCutoffIso}`);

  if (selErr) {
    console.error("[decision-postmortem-reminder:select] failed", {
      message: selErr.message,
    });
    return NextResponse.json(
      { error: "select_failed", detail: selErr.message },
      { status: 500 },
    );
  }

  const rows = (candidates ?? []) as DecisionRow[];

  if (rows.length === 0) {
    console.log("[decision-postmortem-reminder:select] no overdue decisions");
    return NextResponse.json({
      ok: true,
      decisionsFlagged: 0,
      elapsedMs: Date.now() - startedAt,
    });
  }

  // --- Flip status + stamp reminded_at ------------------------------------
  // Single UPDATE keyed on the matched ids. Both committed rows (which
  // transition to postmortem_due) and existing postmortem_due rows (which
  // get re-stamped) are covered by setting status='postmortem_due'
  // unconditionally.
  const ids = rows.map((r) => r.id);
  const { error: updErr } = await supabase
    .from("decisions")
    .update({
      status: "postmortem_due",
      postmortem_reminded_at: nowIso,
      updated_at: nowIso,
    })
    .in("id", ids);

  if (updErr) {
    console.error("[decision-postmortem-reminder:update] failed", {
      message: updErr.message,
      candidateCount: ids.length,
    });
    return NextResponse.json(
      { error: "update_failed", detail: updErr.message },
      { status: 500 },
    );
  }

  const elapsedMs = Date.now() - startedAt;
  console.log("[decision-postmortem-reminder:done]", {
    decisionsFlagged: ids.length,
    elapsedMs,
  });

  return NextResponse.json({
    ok: true,
    decisionsFlagged: ids.length,
    elapsedMs,
  });
}
