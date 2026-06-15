import { NextRequest, NextResponse } from "next/server";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import { classifyContent, classifyCalendarPrep } from "@/lib/prompts/classify";
import type { SupabaseClient } from "@supabase/supabase-js";

// POST /api/cron/classify-pending
//
// Mirror of fetch-bodies in spirit. Now processes THREE queues per firing per
// Tab 2's Commit 4 + Commit 6 locks — three sequential claim calls, separate
// RPCs per source, single classifier prompt + Gemini wrapper. Email batch
// first, Slack batch second, Notion batch third.
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
// Slack queue:
//   Same shape against slack_messages via claim_pending_classify_slack_chunk.
//   classifyContent({ source: 'slack', ... }) injects a source-context
//   addendum into the user prompt so the email-centric decision rules in the
//   system prompt fall through to first-principles for DMs.
//
// Notion queue (new):
//   Same shape against notion_pages via claim_pending_classify_notion_chunk.
//   classifyContent({ source: 'notion', ... }) injects a Notion-specific
//   preface. If the RPC doesn't exist yet (migration 0017 not applied) the
//   batch returns EMPTY_METRICS so email + Slack still ship their numbers.
//
// Calendar queue (Commit 7):
//   Same claim/lookup/classify/write shape against calendar_events via
//   claim_pending_classify_calendar_chunk. DIFFERENT schema: calls
//   classifyCalendarPrep (separate function — not the 4-bucket
//   classifyContent), writes prep_priority + prep_notes instead of
//   classification + classification_reason. Uses its own CalendarBatchMetrics
//   type since the sample shape differs. If migration 0020 isn't applied
//   yet the batch returns EMPTY_CALENDAR_METRICS so email/Slack/Notion
//   still ship.
//
// Cadence (pg_cron) is once per minute. With CLASSIFY_CHUNK_SIZE=5 per source,
// each queue drains at 300 rows/source/hour. Slack and Notion both produce
// far smaller backlogs than email (5-50 events/day vs hundreds of emails)
// so they drain nearly real-time.

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

type ClaimedNotionRow = {
  id: string;
  user_id: string;
  integration_id: string;
  page_id: string;
  title: string;
  snippet: string;
  last_edited_at: string;
};

// Calendar claim row — shape comes from Agent A's
// claim_pending_classify_calendar_chunk RPC. external_attendee_count is
// computed server-side (pgSQL counts attendees whose email domain doesn't
// match the user's primary domain).
type ClaimedCalendarRow = {
  id: string;
  user_id: string;
  calendar_id: string;
  title: string;
  description: string | null;
  start_at: string; // ISO timestamptz
  end_at: string; // ISO timestamptz
  attendee_count: number;
  external_attendee_count: number;
  organizer_self: boolean;
  user_response_status:
    | "accepted"
    | "tentative"
    | "declined"
    | "needsAction"
    | null;
  event_status: "confirmed" | "tentative" | "cancelled";
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

// Calendar samples carry prep_priority instead of the 4-bucket classification —
// separate type rather than widening BatchMetrics into a union with all-optional
// sample fields (messy + no compile-time guarantee on which fields are present).
type CalendarBatchMetrics = {
  claimed: number;
  classified: number;
  failed: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  samples: Array<{
    id: string;
    prep_priority: "high" | "medium" | "low" | "none";
    prep_notes: string;
  }>;
};

const EMPTY_CALENDAR_METRICS: CalendarBatchMetrics = {
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
  const notion = await processNotionBatch(supabase);
  const calendar = await processCalendarBatch(supabase);

  const elapsedMs = Date.now() - startedAt;
  console.log("[classify-pending:done]", {
    email: { claimed: email.claimed, classified: email.classified, failed: email.failed },
    slack: { claimed: slack.claimed, classified: slack.classified, failed: slack.failed },
    notion: { claimed: notion.claimed, classified: notion.classified, failed: notion.failed },
    calendar: { claimed: calendar.claimed, classified: calendar.classified, failed: calendar.failed },
    elapsedMs,
  });

  return NextResponse.json({
    ok: true,
    email,
    slack,
    notion,
    calendar,
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

// ----------------------------------------------------------------------------
// Notion batch
// ----------------------------------------------------------------------------

async function processNotionBatch(supabase: SupabaseClient): Promise<BatchMetrics> {
  // --- Claim ---------------------------------------------------------------
  // If migration 0017 hasn't been applied yet, the RPC won't exist — log + bail
  // gracefully so the email + Slack batches (above) still ship their metrics.
  const { data, error } = await supabase.rpc(
    "claim_pending_classify_notion_chunk",
    { p_limit: CLASSIFY_CHUNK_SIZE },
  );
  if (error) {
    console.error("[classify-pending:notion:claim] rpc failed", {
      message: error.message,
    });
    return EMPTY_METRICS;
  }
  const claimed = (data ?? []) as ClaimedNotionRow[];

  if (claimed.length === 0) {
    console.log("[classify-pending:notion:claim] queue empty");
    return EMPTY_METRICS;
  }

  // --- Lookup user emails -------------------------------------------------
  const userIds = Array.from(new Set(claimed.map((r) => r.user_id)));
  const { data: userRows, error: usersErr } = await supabase
    .from("users")
    .select("id, email")
    .in("id", userIds);
  if (usersErr || !userRows) {
    console.error("[classify-pending:notion:users] lookup failed", {
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
        source: "notion",
        pageTitle: row.title,
        snippet: row.snippet,
        lastEditedAt: row.last_edited_at,
        userEmail,
      });
      return { row, result, usage };
    }),
  );

  // --- Write-back + tally -------------------------------------------------
  // notion_pages mirrors slack_messages: classified_at is timestamptz (ISO
  // string), not bigint epoch ms like the emails table.
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
          .from("notion_pages")
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
          console.error("[classify-pending:notion:write] success-update failed", {
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
        console.error("[classify-pending:notion:llm] classify failed", {
          id: claimedRow.id,
          message: detail,
        });
        const { error: updErr } = await supabase
          .from("notion_pages")
          .update({
            classification_error: detail.slice(0, 500),
            status: "failed",
          })
          .eq("id", claimedRow.id);
        if (updErr) {
          console.error("[classify-pending:notion:write] failure-update failed", {
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
// Calendar batch
// ----------------------------------------------------------------------------

async function processCalendarBatch(
  supabase: SupabaseClient,
): Promise<CalendarBatchMetrics> {
  // --- Claim ---------------------------------------------------------------
  // If migration 0020 hasn't been applied yet, the RPC won't exist — log + bail
  // gracefully so the email/Slack/Notion batches above still ship their metrics.
  const { data, error } = await supabase.rpc(
    "claim_pending_classify_calendar_chunk",
    { p_limit: CLASSIFY_CHUNK_SIZE },
  );
  if (error) {
    console.error("[classify-pending:calendar:claim] rpc failed", {
      message: error.message,
    });
    return EMPTY_CALENDAR_METRICS;
  }
  const claimed = (data ?? []) as ClaimedCalendarRow[];

  if (claimed.length === 0) {
    console.log("[classify-pending:calendar:claim] queue empty");
    return EMPTY_CALENDAR_METRICS;
  }

  // --- Lookup user emails -------------------------------------------------
  // Symmetry with the other batches even though classifyCalendarPrep itself
  // doesn't take userEmail — we still want to fail-fast on a stale claim
  // whose user_id no longer exists in users (data-integrity check).
  const userIds = Array.from(new Set(claimed.map((r) => r.user_id)));
  const { data: userRows, error: usersErr } = await supabase
    .from("users")
    .select("id, email")
    .in("id", userIds);
  if (usersErr || !userRows) {
    console.error("[classify-pending:calendar:users] lookup failed", {
      message: usersErr?.message ?? "no_rows",
    });
    return {
      ...EMPTY_CALENDAR_METRICS,
      claimed: claimed.length,
      failed: claimed.length,
    };
  }
  const userKnown = new Set(userRows.map((u) => u.id));

  // --- Classify in parallel ----------------------------------------------
  const results = await Promise.allSettled(
    claimed.map(async (row) => {
      if (!userKnown.has(row.user_id)) {
        throw new Error(`unknown_user_id:${row.user_id}`);
      }
      const { result, usage } = await classifyCalendarPrep({
        title: row.title,
        description: row.description,
        startAt: row.start_at,
        endAt: row.end_at,
        attendeeCount: row.attendee_count,
        externalAttendeeCount: row.external_attendee_count,
        organizerSelf: row.organizer_self,
        userResponseStatus: row.user_response_status,
        eventStatus: row.event_status,
      });
      return { row, result, usage };
    }),
  );

  // --- Write-back + tally -------------------------------------------------
  // calendar_events uses prep_priority + prep_notes (per Tab 2 spec). classified_at
  // is timestamptz ISO like notion_pages / slack_messages.
  const metrics: CalendarBatchMetrics = {
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
          .from("calendar_events")
          .update({
            prep_priority: result.prep_priority,
            prep_notes: result.prep_notes,
            prep_error: null,
            classified_at: new Date().toISOString(),
            status: "processed",
          })
          .eq("id", claimedRow.id);
        if (updErr) {
          metrics.failed++;
          console.error(
            "[classify-pending:calendar:write] success-update failed",
            {
              id: claimedRow.id,
              message: updErr.message,
            },
          );
        } else {
          metrics.classified++;
          metrics.samples.push({
            id: claimedRow.id,
            prep_priority: result.prep_priority,
            prep_notes: result.prep_notes,
          });
        }
      } else {
        metrics.failed++;
        const detail =
          settled.reason instanceof Error
            ? settled.reason.message
            : String(settled.reason);
        console.error("[classify-pending:calendar:llm] classify failed", {
          id: claimedRow.id,
          message: detail,
        });
        const { error: updErr } = await supabase
          .from("calendar_events")
          .update({
            prep_error: detail.slice(0, 500),
            status: "failed",
          })
          .eq("id", claimedRow.id);
        if (updErr) {
          console.error(
            "[classify-pending:calendar:write] failure-update failed",
            {
              id: claimedRow.id,
              message: updErr.message,
            },
          );
        }
      }
    }),
  );

  return metrics;
}
