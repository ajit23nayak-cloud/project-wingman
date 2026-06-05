import { NextRequest, NextResponse } from "next/server";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import { classifyEmailContent } from "@/lib/prompts/classify";

// POST /api/cron/classify-pending
//
// Mirror of fetch-bodies. Idempotent: re-running after partial failure picks
// up where left off because only successful classifications flip status
// from 'pending' to 'processed' (and only failures flip to 'failed'); rows
// the previous run never touched stay at status='pending' classification=null.
//
// Per firing:
//   1. RPC public.claim_pending_classify_chunk atomically locks up to
//      CLASSIFY_CHUNK_SIZE rows via SELECT FOR UPDATE SKIP LOCKED and stamps
//      classify_claimed_at = now(). Stale claims (>5 min) auto-reclaim, so
//      a route timeout self-heals on the next firing.
//   2. Lookup users.email for the claimed users (one shot via .in()).
//   3. Run classifyEmailContent in parallel via Promise.allSettled — chunk
//      size 5 means 5 concurrent Gemini calls (well inside paid-tier
//      1000 RPM cap). One failure does not poison the chunk.
//   4. Per-row UPDATE: success → classification + reason + classified_at +
//      status='processed'; failure → classification_error + status='failed'.
//
// Cadence (pg_cron) is once per minute. With CLASSIFY_CHUNK_SIZE=5, the
// queue drains at 300 emails/hour — the 198-email backlog finishes in
// ~40 minutes end-to-end.

export const runtime = "nodejs";

const CLASSIFY_CHUNK_SIZE = 5;

type ClaimedRow = {
  id: string;
  user_id: string;
  from_address: string;
  subject: string;
  snippet: string;
};

type SuccessSample = {
  id: string;
  subject: string;
  classification: "urgent" | "important" | "fyi" | "archive";
  reason: string;
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

  // --- Claim ---------------------------------------------------------------
  let claimed: ClaimedRow[];
  {
    const { data, error } = await supabase.rpc(
      "claim_pending_classify_chunk",
      { p_limit: CLASSIFY_CHUNK_SIZE },
    );
    if (error) {
      console.error("[classify-pending:claim] rpc failed", {
        message: error.message,
      });
      return NextResponse.json(
        { error: "claim_failed", detail: error.message },
        { status: 500 },
      );
    }
    // RPC returns an array of rows (setof composite). Empty array on empty
    // queue — never null in practice but we coalesce defensively.
    claimed = (data ?? []) as ClaimedRow[];
  }

  if (claimed.length === 0) {
    console.log("[classify-pending:claim] queue empty");
    return NextResponse.json({
      ok: true,
      claimed: 0,
      classified: 0,
      failed: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      elapsedMs: Date.now() - startedAt,
      samples: [],
    });
  }

  // --- Lookup user emails -------------------------------------------------
  const userIds = Array.from(new Set(claimed.map((r) => r.user_id)));
  const { data: userRows, error: usersErr } = await supabase
    .from("users")
    .select("id, email")
    .in("id", userIds);
  if (usersErr || !userRows) {
    console.error("[classify-pending:users] lookup failed", {
      message: usersErr?.message ?? "no_rows",
    });
    return NextResponse.json(
      { error: "users_lookup_failed" },
      { status: 500 },
    );
  }
  const emailByUserId = new Map<string, string>();
  for (const u of userRows) emailByUserId.set(u.id, u.email);

  // --- Classify in parallel ----------------------------------------------
  const results = await Promise.allSettled(
    claimed.map(async (row) => {
      const userEmail = emailByUserId.get(row.user_id);
      if (!userEmail) {
        throw new Error(`no_user_email_for_user_id:${row.user_id}`);
      }
      const { result, usage } = await classifyEmailContent({
        fromAddress: row.from_address,
        subject: row.subject,
        snippet: row.snippet,
        userEmail,
      });
      return { row, result, usage };
    }),
  );

  // --- Write-back + tally -------------------------------------------------
  let classified = 0;
  let failed = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const samples: SuccessSample[] = [];

  await Promise.all(
    results.map(async (settled, idx) => {
      const claimedRow = claimed[idx];
      if (settled.status === "fulfilled") {
        const { result, usage } = settled.value;
        totalInputTokens += usage.inputTokens ?? 0;
        totalOutputTokens += usage.outputTokens ?? 0;
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
          console.error("[classify-pending:write] success-update failed", {
            id: claimedRow.id,
            message: updErr.message,
          });
        } else {
          classified++;
          samples.push({
            id: claimedRow.id,
            subject: claimedRow.subject,
            classification: result.classification,
            reason: result.reason,
          });
        }
      } else {
        failed++;
        const detail =
          settled.reason instanceof Error
            ? settled.reason.message
            : String(settled.reason);
        console.error("[classify-pending:llm] classify failed", {
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
          console.error("[classify-pending:write] failure-update failed", {
            id: claimedRow.id,
            message: updErr.message,
          });
        }
      }
    }),
  );

  const elapsedMs = Date.now() - startedAt;
  console.log("[classify-pending:done]", {
    claimed: claimed.length,
    classified,
    failed,
    totalInputTokens,
    totalOutputTokens,
    elapsedMs,
  });

  return NextResponse.json({
    ok: true,
    claimed: claimed.length,
    classified,
    failed,
    totalInputTokens,
    totalOutputTokens,
    elapsedMs,
    samples,
  });
}
