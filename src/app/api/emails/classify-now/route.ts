import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import { classifyContent } from "@/lib/prompts/classify";

// POST /api/emails/classify-now
//
// Manual on-demand classify trigger fired by the "classify all" button on the
// dashboard. Mirrors the email branch of /api/cron/classify-pending but
// scoped to the current Clerk user instead of the global claim RPC.
//
// Per-user scope rationale: the cron's claim_pending_classify_chunk RPC is
// global (no user_id arg) and would race with this manual trigger if both
// fired at the same row. Instead we query directly for this user's pending
// rows and immediately stamp status='processing' so the cron's predicate
// (status='pending') skips them. Lower-risk than introducing a new migration.
//
// Batch size matches CLASSIFY_CHUNK_SIZE=5 from the cron — same Gemini RPM
// envelope, no surprises. Concurrency via Promise.allSettled so one bad row
// doesn't poison the batch.
//
// Per CONVENTIONS rule (d): logs only counts + supabaseUserId + error
// messages. Never email subjects, bodies, or addresses.

export const runtime = "nodejs";

const CLASSIFY_CHUNK_SIZE = 5;

type PendingEmailRow = {
  id: string;
  from_address: string;
  subject: string;
  snippet: string;
  received_at: number;
};

export async function POST(req: NextRequest) {
  const auth = await resolveUser(req);
  if (!auth.ok) return auth.response;
  const { supabaseUserId, email: userEmail } = auth.user;

  const supabase = makeSupabaseServerClient();

  // --- Claim: select up to N pending rows and stamp 'processing' ----------
  // Two-step (select then update by id list) because PostgREST doesn't
  // expose a single-statement claim-and-return. The window between the
  // select and the update is tiny; even if the cron's claim_pending_classify
  // RPC ran in that window it would still skip rows whose status we're
  // about to flip (the cron's SELECT FOR UPDATE SKIP LOCKED defends the
  // other direction). Worst-case race = the row gets classified twice and
  // the second writer wins — same final state, just one wasted LLM call.
  const { data: candidates, error: selErr } = await supabase
    .from("emails")
    .select("id, from_address, subject, snippet, received_at")
    .eq("user_id", supabaseUserId)
    .eq("status", "pending")
    .eq("archived_stale", false)
    .is("classification", null)
    .order("created_at", { ascending: true })
    .limit(CLASSIFY_CHUNK_SIZE);
  if (selErr) {
    console.error("[emails/classify-now:select] failed", {
      supabaseUserId,
      message: selErr.message,
    });
    return NextResponse.json(
      { ok: false, error: "select_failed" },
      { status: 500 },
    );
  }
  const claimed = (candidates ?? []) as PendingEmailRow[];

  if (claimed.length === 0) {
    return NextResponse.json({
      ok: true,
      classified: 0,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  }

  const claimedIds = claimed.map((r) => r.id);
  const { error: claimErr } = await supabase
    .from("emails")
    .update({ status: "processing" })
    .in("id", claimedIds)
    .eq("user_id", supabaseUserId);
  if (claimErr) {
    console.error("[emails/classify-now:claim] failed", {
      supabaseUserId,
      count: claimedIds.length,
      message: claimErr.message,
    });
    return NextResponse.json(
      { ok: false, error: "claim_failed" },
      { status: 500 },
    );
  }

  // --- Classify in parallel ------------------------------------------------
  const results = await Promise.allSettled(
    claimed.map(async (row) => {
      const { result, usage } = await classifyContent({
        source: "gmail",
        fromAddress: row.from_address,
        subject: row.subject,
        snippet: row.snippet,
        userEmail,
      });
      return { row, result, usage };
    }),
  );

  // --- Write-back + tally --------------------------------------------------
  let classified = 0;
  let failed = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  await Promise.all(
    results.map(async (settled, idx) => {
      const claimedRow = claimed[idx];
      if (settled.status === "fulfilled") {
        const { result, usage } = settled.value;
        inputTokens += usage.inputTokens ?? 0;
        outputTokens += usage.outputTokens ?? 0;
        const { error: updErr } = await supabase
          .from("emails")
          .update({
            classification: result.classification,
            classification_reason: result.reason,
            classification_error: null,
            classified_at: Date.now(),
            status: "processed",
            processed_at: Date.now(),
          })
          .eq("id", claimedRow.id);
        if (updErr) {
          failed++;
          console.error("[emails/classify-now:write] success-update failed", {
            supabaseUserId,
            id: claimedRow.id,
            message: updErr.message,
          });
        } else {
          classified++;
        }
      } else {
        failed++;
        const detail =
          settled.reason instanceof Error
            ? settled.reason.message
            : String(settled.reason);
        console.error("[emails/classify-now:llm] classify failed", {
          supabaseUserId,
          id: claimedRow.id,
          message: detail,
        });
        const { error: updErr } = await supabase
          .from("emails")
          .update({
            classification_error: detail.slice(0, 500),
            status: "failed",
            processed_at: Date.now(),
          })
          .eq("id", claimedRow.id);
        if (updErr) {
          console.error("[emails/classify-now:write] failure-update failed", {
            supabaseUserId,
            id: claimedRow.id,
            message: updErr.message,
          });
        }
      }
    }),
  );

  console.log("[emails/classify-now:done]", {
    supabaseUserId,
    claimed: claimed.length,
    classified,
    failed,
    inputTokens,
    outputTokens,
  });

  return NextResponse.json({
    ok: true,
    classified,
    failed,
    inputTokens,
    outputTokens,
  });
}
