import { NextRequest, NextResponse } from "next/server";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import { classifyContent } from "@/lib/prompts/classify";
import type { SupabaseClient } from "@supabase/supabase-js";

// POST /api/cron/classify-pending
//
// Mirror of fetch-bodies in spirit. Now processes TWO queues per firing per
// Tab 2's Commit 4 lock (a) — two sequential claim calls, separate RPCs per
// source, single classifier prompt + Gemini wrapper. Email batch first, Slack
// batch second.
//
// Email queue (existing):
//   1. RPC public.claim_pending_classify_chunk atomically locks up to
//      CLASSIFY_CHUNK_SIZE rows via SELECT FOR UPDATE SKIP LOCKED and stamps
//      classify_claimed_at = now(). Stale claims (>5 min) auto-reclaim, so
//      a route timeout self-heals on the next firing.
//   2. Lookup users.email for the claimed users (one shot via .in()).
//   3. Run classifyContent({ source: 'gmail', ... }) in parallel via
//      Promise.allSettled — chunk size 5 means 5 concurrent Gemini calls
//      (well inside paid-tier 1000 RPM cap).
//   4. Per-row UPDATE: success → classification + reason + classified_at +
//      status='processed'; failure → classification_error + status='failed'.
//
// Slack queue (new):
//   Same shape against slack_messages via claim_pending_classify_slack_chunk.
//   classifyContent({ source: 'slack', ... }) injects a source-context
//   addendum into the user prompt so the email-centric decision rules in the
//   system prompt fall through to first-principles for DMs.
//
// Cadence (pg_cron) is once per minute. With CLASSIFY_CHUNK_SIZE=5 per source,
// the queues drain at 300 rows/source/hour. Slack 15-min ingest produces a
// far smaller backlog than email (5-50 DMs/day vs hundreds of emails) so
// Slack drains nearly real-time.

export const runtime = "nodejs";

const CLASSIFY_CHUNK_SIZE = 5;

type ClaimedEmailRow = {
  id: string;
  user_id: string;
  from_address: string;
  subject: string;
  snippet: string;
};

type ClaimedSlackRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  channel_id: string;
  sender_id: string;
  sender_name: string | null;
  text: string;
};

type BatchMetrics = {
  claimed: number;
  classified: number;
  failed: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  samples: Array<{
    id: string;
    classification: "urgent" | "important" | "fyi" | "archive";
    reason: string;
    subject?: string;
  }>;
};

const EMPTY_METRICS: BatchMetrics = {
  claimed: 0,
  classified: 0,
  failed: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  samples: [],
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

  const email = await processEmailBatch(supabase);
  const slack = await processSlackBatch(supabase);

  const elapsedMs = Date.now() - startedAt;
  console.log("[classify-pending:done]", {
    email: { claimed: email.claimed, classified: email.classified, failed: email.failed },
    slack: { claimed: slack.claimed, classified: slack.classified, failed: slack.failed },
    elapsedMs,
  });

  return NextResponse.json({
    ok: true,
    email,
    slack,
    elapsedMs,
  });
}

// ----------------------------------------------------------------------------
// Email batch
// ----------------------------------------------------------------------------

async function processEmailBatch(supabase: SupabaseClient): Promise<BatchMetrics> {
  // --- Claim ---------------------------------------------------------------
  const { data, error } = await supabase.rpc("claim_pending_classify_chunk", {
    p_limit: CLASSIFY_CHUNK_SIZE,
  });
  if (error) {
    console.error("[classify-pending:email:claim] rpc failed", {
      message: error.message,
    });
    return EMPTY_METRICS;
  }
  const claimed = (data ?? []) as ClaimedEmailRow[];

  if (claimed.length === 0) {
    console.log("[classify-pending:email:claim] queue empty");
    return EMPTY_METRICS;
  }

  // --- Lookup user emails -------------------------------------------------
  const userIds = Array.from(new Set(claimed.map((r) => r.user_id)));
  const { data: userRows, error: usersErr } = await supabase
    .from("users")
    .select("id, email")
    .in("id", userIds);
  if (usersErr || !userRows) {
    console.error("[classify-pending:email:users] lookup failed", {
      message: usersErr?.message ?? "no_rows",
    });
    // Mark whole batch failed so the rows leave 'pending' and stop monopolizing
    // claim-locks. Same self-healing posture as the original route.
    return { ...EMPTY_METRICS, claimed: claimed.length, failed: claimed.length };
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

  // --- Write-back + tally -------------------------------------------------
  const metrics: BatchMetrics = {
    claimed: claimed.length,
    classified: 0,
    failed: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    samples: [],
  };

  await Promise.all(
    results.map(async (settled, idx) => {
      const claimedRow = claimed[idx];
      if (settled.status === "fulfilled") {
        const { result, usage } = settled.value;
        metrics.totalInputTokens += usage.inputTokens ?? 0;
        metrics.totalOutputTokens += usage.outputTokens ?? 0;
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
          metrics.failed++;
          console.error("[classify-pending:email:write] success-update failed", {
            id: claimedRow.id,
            message: updErr.message,
          });
        } else {
          metrics.classified++;
          metrics.samples.push({
            id: claimedRow.id,
            subject: claimedRow.subject,
            classification: result.classification,
            reason: result.reason,
          });
        }
      } else {
        metrics.failed++;
        const detail =
          settled.reason instanceof Error
            ? settled.reason.message
            : String(settled.reason);
        console.error("[classify-pending:email:llm] classify failed", {
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
          console.error("[classify-pending:email:write] failure-update failed", {
            id: claimedRow.id,
            message: updErr.message,
          });
        }
      }
    }),
  );

  return metrics;
}

// ----------------------------------------------------------------------------
// Slack batch
// ----------------------------------------------------------------------------

async function processSlackBatch(supabase: SupabaseClient): Promise<BatchMetrics> {
  // --- Claim ---------------------------------------------------------------
  // If migration 0015 hasn't been applied yet, the RPC won't exist — log + bail
  // gracefully so the email batch (above) still ships its metrics.
  const { data, error } = await supabase.rpc(
    "claim_pending_classify_slack_chunk",
    { p_limit: CLASSIFY_CHUNK_SIZE },
  );
  if (error) {
    console.error("[classify-pending:slack:claim] rpc failed", {
      message: error.message,
    });
    return EMPTY_METRICS;
  }
  const claimed = (data ?? []) as ClaimedSlackRow[];

  if (claimed.length === 0) {
    console.log("[classify-pending:slack:claim] queue empty");
    return EMPTY_METRICS;
  }

  // --- Lookup user emails -------------------------------------------------
  const userIds = Array.from(new Set(claimed.map((r) => r.user_id)));
  const { data: userRows, error: usersErr } = await supabase
    .from("users")
    .select("id, email")
    .in("id", userIds);
  if (usersErr || !userRows) {
    console.error("[classify-pending:slack:users] lookup failed", {
      message: usersErr?.message ?? "no_rows",
    });
    return { ...EMPTY_METRICS, claimed: claimed.length, failed: claimed.length };
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
      const { result, usage } = await classifyContent({
        source: "slack",
        senderName: row.sender_name,
        senderId: row.sender_id,
        channelId: row.channel_id,
        text: row.text,
        userEmail,
      });
      return { row, result, usage };
    }),
  );

  // --- Write-back + tally -------------------------------------------------
  // slack_messages doesn't have a processed_at column (per migration 0014) —
  // status + classified_at carry the same meaning. classified_at is timestamptz
  // here, not bigint epoch ms like the emails table.
  const metrics: BatchMetrics = {
    claimed: claimed.length,
    classified: 0,
    failed: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    samples: [],
  };

  await Promise.all(
    results.map(async (settled, idx) => {
      const claimedRow = claimed[idx];
      if (settled.status === "fulfilled") {
        const { result, usage } = settled.value;
        metrics.totalInputTokens += usage.inputTokens ?? 0;
        metrics.totalOutputTokens += usage.outputTokens ?? 0;
        const { error: updErr } = await supabase
          .from("slack_messages")
          .update({
            classification: result.classification,
            classification_reason: result.reason,
            classification_error: null,
            classified_at: new Date().toISOString(),
            status: "processed",
          })
          .eq("id", claimedRow.id);
        if (updErr) {
          metrics.failed++;
          console.error("[classify-pending:slack:write] success-update failed", {
            id: claimedRow.id,
            message: updErr.message,
          });
        } else {
          metrics.classified++;
          metrics.samples.push({
            id: claimedRow.id,
            classification: result.classification,
            reason: result.reason,
          });
        }
      } else {
        metrics.failed++;
        const detail =
          settled.reason instanceof Error
            ? settled.reason.message
            : String(settled.reason);
        console.error("[classify-pending:slack:llm] classify failed", {
          id: claimedRow.id,
          message: detail,
        });
        const { error: updErr } = await supabase
          .from("slack_messages")
          .update({
            classification_error: detail.slice(0, 500),
            status: "failed",
          })
          .eq("id", claimedRow.id);
        if (updErr) {
          console.error("[classify-pending:slack:write] failure-update failed", {
            id: claimedRow.id,
            message: updErr.message,
          });
        }
      }
    }),
  );

  return metrics;
}
