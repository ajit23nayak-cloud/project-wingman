import { NextRequest, NextResponse } from "next/server";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import { getGoogleAccessToken } from "@/lib/clerk";
import {
  getEmailsByIdsLenient,
  GmailAuthError,
  type EmailIdRef,
  type LenientFetchOutcome,
} from "@/lib/gmail";
import { BODY_FETCH_CHUNK_SIZE } from "@/lib/limits";
import {
  markGmailReauthNeeded,
  clearGmailReauthFlag,
} from "@/lib/auth/gmailReauth";

// POST /api/cron/fetch-bodies
//
// pg_cron-driven worker that drains the pending_fetch queue created by
// /api/ingest-emails. Each firing:
//   1. Atomically claims up to BODY_FETCH_CHUNK_SIZE rows via the Postgres
//      SECURITY DEFINER function private.claim_pending_fetch_chunk (uses
//      SELECT FOR UPDATE SKIP LOCKED + stamps body_fetch_claimed_at). Stale
//      claims (>5 min) auto-reclaim, so a route timeout self-heals.
//   2. Groups claimed rows by user, fetches each user's Google OAuth token
//      from Clerk (~300ms once per user per firing), runs Gmail
//      messages.get with per-row error isolation, then UPDATEs each row in
//      place.
//   3. On per-row outcomes:
//        - ok   → status='pending' + metadata, classifier picks it up next
//        - 404  → status='failed', classification_error='gmail_404_message_
//                 not_found', archived_stale=true (Flag 2 belt-and-suspenders)
//        - err  → leave row pending_fetch with claimed_at; the 5-min stale
//                 window will re-issue on a subsequent firing.
//   4. Writes one cron_runs row per user batch + an "end of firing" summary
//      row, so cron_recent_failures can surface per-stage failures.
//
// FIFO across users (sharp question answer (a)) — v1.1 work to add round
// robin if multi-user contention shows up. 10-user trial unlikely to hit it.

export const runtime = "nodejs";

const JOB_NAME = "fetch-bodies";

type ClaimedRow = {
  id: string;
  user_id: string;
  gmail_message_id: string;
  thread_id: string;
};

type CronRunInsert = {
  job_name: string;
  ok: boolean;
  user_id?: string | null;
  stage?: string | null;
  error_code?: string | null;
  detail?: string | null;
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
  const summary = {
    claimed: 0,
    succeeded: 0,
    failed404: 0,
    transientErrors: 0,
    skippedNoToken: 0,
    userBatches: 0,
  };
  const runs: CronRunInsert[] = [];

  // --- Claim ---------------------------------------------------------------
  let claimed: ClaimedRow[];
  {
    const { data, error } = await supabase.rpc(
      "claim_pending_fetch_chunk",
      { p_limit: BODY_FETCH_CHUNK_SIZE },
    );
    if (error) {
      console.error("[fetch-bodies:claim] rpc failed", {
        message: error.message,
      });
      runs.push({
        job_name: JOB_NAME,
        ok: false,
        stage: "claim",
        error_code: "rpc_failed",
        detail: error.message,
      });
      await flushCronRuns(supabase, runs);
      return NextResponse.json(
        { error: "claim_failed", detail: error.message },
        { status: 500 },
      );
    }
    claimed = (data ?? []) as ClaimedRow[];
    summary.claimed = claimed.length;
  }

  if (claimed.length === 0) {
    console.log("[fetch-bodies:claim] queue empty");
    runs.push({
      job_name: JOB_NAME,
      ok: true,
      stage: "claim",
      detail: "empty_queue",
    });
    await flushCronRuns(supabase, runs);
    return NextResponse.json({ ...summary, durationMs: Date.now() - startedAt });
  }

  // --- Group by user ------------------------------------------------------
  const byUser = new Map<string, ClaimedRow[]>();
  for (const row of claimed) {
    const list = byUser.get(row.user_id) ?? [];
    list.push(row);
    byUser.set(row.user_id, list);
  }
  summary.userBatches = byUser.size;

  // --- Fetch clerk_user_id for each user in one shot ----------------------
  const userIds = Array.from(byUser.keys());
  const { data: userRows, error: usersErr } = await supabase
    .from("users")
    .select("id, clerk_user_id")
    .in("id", userIds);
  if (usersErr || !userRows) {
    console.error("[fetch-bodies:users] lookup failed", {
      message: usersErr?.message ?? "no_rows",
    });
    runs.push({
      job_name: JOB_NAME,
      ok: false,
      stage: "users_lookup",
      error_code: "users_lookup_failed",
      detail: usersErr?.message ?? "no_rows",
    });
    await flushCronRuns(supabase, runs);
    return NextResponse.json(
      { error: "users_lookup_failed" },
      { status: 500 },
    );
  }
  const clerkIdByUser = new Map<string, string>();
  for (const u of userRows) clerkIdByUser.set(u.id, u.clerk_user_id);

  // --- Per-user batch processing ------------------------------------------
  for (const [userId, rows] of byUser) {
    const clerkUserId = clerkIdByUser.get(userId);
    if (!clerkUserId) {
      console.error("[fetch-bodies:users] missing clerk_user_id", { userId });
      runs.push({
        job_name: JOB_NAME,
        ok: false,
        user_id: userId,
        stage: "users_lookup",
        error_code: "missing_clerk_user_id",
      });
      summary.skippedNoToken += rows.length;
      continue;
    }

    // -- token --
    let token: string | null;
    try {
      token = await getGoogleAccessToken(clerkUserId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[fetch-bodies:token] clerk fetch threw", {
        userId,
        message: detail,
      });
      runs.push({
        job_name: JOB_NAME,
        ok: false,
        user_id: userId,
        stage: "token",
        error_code: "clerk_sdk_threw",
        detail,
      });
      await markGmailReauthNeeded(supabase, userId);
      summary.skippedNoToken += rows.length;
      continue;
    }
    if (!token) {
      console.warn("[fetch-bodies:token] no google token", { userId });
      runs.push({
        job_name: JOB_NAME,
        ok: false,
        user_id: userId,
        stage: "token",
        error_code: "no_google_token",
      });
      await markGmailReauthNeeded(supabase, userId);
      summary.skippedNoToken += rows.length;
      continue;
    }
    console.log("[fetch-bodies:token] resolved", {
      userId,
      rowCount: rows.length,
    });

    // -- gmail batch --
    const ids: EmailIdRef[] = rows.map((r) => ({
      messageId: r.gmail_message_id,
      threadId: r.thread_id,
    }));
    let outcomes: LenientFetchOutcome[];
    try {
      outcomes = await getEmailsByIdsLenient(token, ids, 5);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const isAuth = err instanceof GmailAuthError;
      console.error("[fetch-bodies:fetch] batch threw", {
        userId,
        message: detail,
        isAuth,
      });
      runs.push({
        job_name: JOB_NAME,
        ok: false,
        user_id: userId,
        stage: "fetch",
        error_code: isAuth ? "gmail_auth_failed" : "gmail_batch_threw",
        detail,
      });
      if (isAuth) {
        await markGmailReauthNeeded(supabase, userId);
        summary.skippedNoToken += rows.length;
      } else {
        summary.transientErrors += rows.length;
      }
      continue;
    }
    // Per-user batch returned successfully — Gmail OAuth is valid for this
    // user. Self-heal the flag (strategy ii) so out-of-band reconnects don't
    // leave a stale banner.
    await clearGmailReauthFlag(supabase, userId);

    // -- map per-row outcome → UPDATE --
    // Match outcomes back to claimed rows by gmail_message_id so we know
    // which Supabase row to UPDATE.
    const rowByMsgId = new Map<string, ClaimedRow>();
    for (const r of rows) rowByMsgId.set(r.gmail_message_id, r);

    let userOk = 0;
    let userNotFound = 0;
    let userErr = 0;

    for (const o of outcomes) {
      const claimedRow = rowByMsgId.get(o.id.messageId);
      if (!claimedRow) continue; // shouldn't happen but defensive

      if (o.result.kind === "ok") {
        const e = o.result.data;
        const { error: updErr } = await supabase
          .from("emails")
          .update({
            from_address: e.fromAddress,
            to_addresses: e.toAddresses,
            subject: e.subject,
            snippet: e.snippet,
            received_at: e.receivedAt.getTime(),
            status: "pending",
          })
          .eq("id", claimedRow.id);
        if (updErr) {
          userErr++;
          summary.transientErrors++;
          console.error("[fetch-bodies:write] row update failed", {
            userId,
            rowId: claimedRow.id,
            message: updErr.message,
          });
          runs.push({
            job_name: JOB_NAME,
            ok: false,
            user_id: userId,
            stage: "write",
            error_code: "row_update_failed",
            detail: updErr.message,
          });
        } else {
          userOk++;
          summary.succeeded++;
        }
      } else if (o.result.kind === "not_found") {
        const { error: updErr } = await supabase
          .from("emails")
          .update({
            status: "failed",
            classification_error: "gmail_404_message_not_found",
            archived_stale: true,
          })
          .eq("id", claimedRow.id);
        if (updErr) {
          userErr++;
          summary.transientErrors++;
          console.error("[fetch-bodies:write] 404 update failed", {
            userId,
            rowId: claimedRow.id,
            message: updErr.message,
          });
          runs.push({
            job_name: JOB_NAME,
            ok: false,
            user_id: userId,
            stage: "write",
            error_code: "row_update_failed_on_404",
            detail: updErr.message,
          });
        } else {
          userNotFound++;
          summary.failed404++;
          runs.push({
            job_name: JOB_NAME,
            ok: false,
            user_id: userId,
            stage: "fetch",
            error_code: "gmail_404",
            detail: claimedRow.gmail_message_id,
          });
        }
      } else {
        userErr++;
        summary.transientErrors++;
        console.error("[fetch-bodies:fetch] per-row error", {
          userId,
          rowId: claimedRow.id,
          detail: o.result.detail,
        });
        runs.push({
          job_name: JOB_NAME,
          ok: false,
          user_id: userId,
          stage: "fetch",
          error_code: "gmail_per_row_error",
          detail: o.result.detail.slice(0, 200),
        });
      }
    }

    // Per-user summary row — even when everything went fine, gives us a
    // ground-truth trail for "this user processed N this firing."
    runs.push({
      job_name: JOB_NAME,
      ok: userErr === 0,
      user_id: userId,
      stage: "user_batch_complete",
      detail: `ok=${userOk} 404=${userNotFound} err=${userErr}`,
    });
  }

  // --- End-of-firing summary ---------------------------------------------
  console.log("[fetch-bodies:done]", { ...summary });
  runs.push({
    job_name: JOB_NAME,
    ok: summary.transientErrors === 0 && summary.skippedNoToken === 0,
    stage: "complete",
    detail: JSON.stringify(summary),
  });
  await flushCronRuns(supabase, runs);

  return NextResponse.json({ ...summary, durationMs: Date.now() - startedAt });
}

async function flushCronRuns(
  supabase: ReturnType<typeof makeSupabaseServerClient>,
  runs: CronRunInsert[],
) {
  if (runs.length === 0) return;
  const { error } = await supabase.from("cron_runs").insert(runs);
  if (error) {
    // We can't write a cron_runs failure to cron_runs — fall back to logs.
    console.error("[fetch-bodies:cron_runs] insert failed", {
      message: error.message,
      rowCount: runs.length,
    });
  }
}
