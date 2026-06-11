import { NextRequest, NextResponse } from "next/server";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import {
  SlackAuthError,
  listImChannels,
  fetchConversationHistory,
  usersInfo,
  type SlackMessage,
} from "@/lib/slack/client";

// POST /api/cron/ingest-slack
//
// Per-firing per-workspace ingest of Slack DM history. Mirror of fetch-bodies
// in spirit (cron-gated, service-role Supabase, JSON summary), but the unit
// of work is per-workspace serial loops rather than a queue-claim chunk.
//
// Single-user-v0 simplification: workspaces are processed serially. When v1
// adds multi-tenant load, this becomes a chunked claim pattern (same RPC
// shape as claim_pending_classify_chunk).
//
// Lookback rules:
//   - last_polled_at IS NULL → poll the last 7 days (first-poll cold start).
//   - last_polled_at SET     → poll since last_polled_at.
// Slack's conversations.history `oldest` param is Unix epoch SECONDS, not ms.
//
// Idempotency: bulk insert is an upsert on (workspace_id, channel_id,
// message_ts) with ignoreDuplicates=true. A partial-failure re-poll picks
// the same window and silently no-ops on rows already inserted. last_polled_at
// only advances after a successful workspace pass — so a mid-workspace
// failure rewinds to the last good watermark on the next firing.
//
// Auth-error handling: a SlackAuthError on ANY API call for a workspace
// flips that workspace to status='disconnected', stamps disconnected_at,
// and the loop continues with the next workspace. The 15-min cron skips
// disconnected workspaces via the slack_workspaces_active partial index.

export const runtime = "nodejs";

// 7 days in seconds — Slack `oldest` param convention.
const FIRST_POLL_LOOKBACK_SEC = 7 * 24 * 60 * 60;
// Hard cap on history pagination per channel per firing. Prevents a runaway
// channel from monopolizing a single cron run. At Slack Tier 3 (50 req/min)
// this is well under one workspace's budget.
const MAX_HISTORY_PAGES_PER_CHANNEL = 20;

type WorkspaceRow = {
  id: string;
  user_id: string;
  team_id: string;
  last_polled_at: string | null;
};

type CredentialRow = {
  workspace_id: string;
  bot_token: string;
};

type InsertRow = {
  user_id: string;
  workspace_id: string;
  channel_id: string;
  thread_ts: string | null;
  message_ts: string;
  sender_id: string;
  sender_name: string | null;
  text: string;
  is_dm: boolean;
  received_at: number;
  raw: SlackMessage;
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

  // --- Load active workspaces + their credentials --------------------------
  const { data: wsRows, error: wsErr } = await supabase
    .from("slack_workspaces")
    .select("id, user_id, team_id, last_polled_at")
    .eq("status", "active");

  if (wsErr) {
    console.error("[ingest-slack:load] workspaces select failed", {
      message: wsErr.message,
    });
    return NextResponse.json(
      { error: "workspaces_load_failed", detail: wsErr.message },
      { status: 500 },
    );
  }

  const workspaces = (wsRows ?? []) as WorkspaceRow[];

  if (workspaces.length === 0) {
    console.log("[ingest-slack:load] no active workspaces");
    return NextResponse.json({
      ok: true,
      workspacesProcessed: 0,
      messagesUpserted: 0,
      workspacesDisconnected: 0,
      elapsedMs: Date.now() - startedAt,
    });
  }

  const workspaceIds = workspaces.map((w) => w.id);
  const { data: credRows, error: credErr } = await supabase
    .from("slack_credentials")
    .select("workspace_id, bot_token")
    .in("workspace_id", workspaceIds);

  if (credErr) {
    console.error("[ingest-slack:load] credentials select failed", {
      message: credErr.message,
    });
    return NextResponse.json(
      { error: "credentials_load_failed", detail: credErr.message },
      { status: 500 },
    );
  }

  const tokenByWorkspace = new Map<string, string>();
  for (const c of (credRows ?? []) as CredentialRow[]) {
    tokenByWorkspace.set(c.workspace_id, c.bot_token);
  }

  // --- Per-workspace serial loop ------------------------------------------
  let workspacesProcessed = 0;
  let messagesUpserted = 0;
  let workspacesDisconnected = 0;

  for (const ws of workspaces) {
    const botToken = tokenByWorkspace.get(ws.id);
    if (!botToken) {
      // Credentials row missing — log and skip. Reconnect flow should
      // re-insert. Don't flip status; keep status='active' so a later
      // OAuth completion can re-attach without an extra repair step.
      console.error("[ingest-slack:workspace] missing credentials, skipping", {
        workspaceId: ws.id,
      });
      continue;
    }

    // Compute `since` as Unix epoch seconds for the Slack `oldest` param.
    const oldestSec = ws.last_polled_at
      ? Math.floor(new Date(ws.last_polled_at).getTime() / 1000)
      : Math.floor(Date.now() / 1000) - FIRST_POLL_LOOKBACK_SEC;

    try {
      // --- 1. Discover IM channels ---------------------------------------
      const channels = await listImChannels(botToken);

      // --- 2. Paginate history per channel; collect raw messages --------
      const collected: { channelId: string; msg: SlackMessage }[] = [];
      for (const ch of channels) {
        let cursor: string | undefined = undefined;
        let pages = 0;
        do {
          const { messages, nextCursor } = await fetchConversationHistory(
            botToken,
            ch.id,
            oldestSec,
            cursor,
          );
          for (const m of messages) collected.push({ channelId: ch.id, msg: m });
          cursor = nextCursor;
          pages += 1;
          if (pages >= MAX_HISTORY_PAGES_PER_CHANNEL) {
            console.warn("[ingest-slack:history] page cap hit, deferring rest", {
              workspaceId: ws.id,
              channelId: ch.id,
              pages,
            });
            break;
          }
        } while (cursor);
      }

      // --- 3. Filter out non-user / empty / bot / subtype messages ------
      const eligible = collected.filter(({ msg }) => {
        if (msg.subtype) return false; // channel_join, message_changed, etc.
        if (msg.bot_id) return false; // bot messages
        if (!msg.text || msg.text.trim().length === 0) return false;
        if (!msg.user) return false; // defensive — should never happen post-filter
        return true;
      });

      // --- 4. Resolve sender names ----------------------------------------
      const senderIds = Array.from(new Set(eligible.map(({ msg }) => msg.user)));
      const senderNameById =
        senderIds.length > 0
          ? await usersInfo(botToken, senderIds)
          : new Map<string, string>();

      // --- 5. Build insert rows ------------------------------------------
      const insertRows: InsertRow[] = eligible.map(({ channelId, msg }) => {
        // Slack ts: "epoch_seconds.microseconds" (string). Multiply by 1000
        // to normalize into epoch ms (matches emails.received_at convention).
        const receivedAtMs = Math.floor(parseFloat(msg.ts) * 1000);
        const resolvedName = senderNameById.get(msg.user) ?? null;
        return {
          user_id: ws.user_id,
          workspace_id: ws.id,
          channel_id: channelId,
          thread_ts: msg.thread_ts ?? null,
          message_ts: msg.ts,
          sender_id: msg.user,
          sender_name: resolvedName && resolvedName.length > 0 ? resolvedName : null,
          text: msg.text,
          is_dm: true,
          received_at: receivedAtMs,
          raw: msg,
        };
      });

      // --- 6. Bulk upsert (idempotent on UNIQUE) -------------------------
      // We don't pass count:'exact' because postgrest with
      // ignoreDuplicates:true returns null/empty for count on some versions.
      // The reported number is "candidates considered" (rows we attempted to
      // insert); on re-poll, duplicates are silently ignored at the DB level.
      let upserted = 0;
      if (insertRows.length > 0) {
        const { error: insertErr } = await supabase
          .from("slack_messages")
          .upsert(insertRows, {
            onConflict: "workspace_id,channel_id,message_ts",
            ignoreDuplicates: true,
          });
        if (insertErr) {
          // Treat as transient — don't disconnect the workspace, don't
          // advance last_polled_at. Next firing retries the same window.
          console.error("[ingest-slack:insert] upsert failed", {
            workspaceId: ws.id,
            rows: insertRows.length,
            message: insertErr.message,
          });
          continue;
        }
        upserted = insertRows.length;
      }

      // --- 7. Advance watermark ------------------------------------------
      // Stamp the watermark to (firing start - 60s overlap). The overlap
      // covers the small race where a message lands in Slack between our
      // history-fetch and now() — next firing's `oldest` includes it, and
      // the UNIQUE(workspace_id, channel_id, message_ts) constraint
      // dedupes any messages we already ingested in this firing.
      const watermarkIso = new Date(startedAt - 60_000).toISOString();
      const { error: wmErr } = await supabase
        .from("slack_workspaces")
        .update({ last_polled_at: watermarkIso })
        .eq("id", ws.id);
      if (wmErr) {
        console.error("[ingest-slack:watermark] update failed", {
          workspaceId: ws.id,
          message: wmErr.message,
        });
        // Inserts already landed (idempotent on next firing anyway); count
        // the workspace as processed but log loudly.
      }

      workspacesProcessed += 1;
      messagesUpserted += upserted;
      console.log("[ingest-slack:workspace] ok", {
        workspaceId: ws.id,
        teamId: ws.team_id,
        channels: channels.length,
        collected: collected.length,
        eligible: eligible.length,
        upserted,
        oldestSec,
      });
    } catch (err) {
      if (err instanceof SlackAuthError) {
        // Token revoked / app uninstalled / not_authed. Flip workspace
        // to disconnected so the next cron skips it. Reconnect flow
        // (out of scope here) is responsible for flipping back.
        const { error: disconnectErr } = await supabase
          .from("slack_workspaces")
          .update({
            status: "disconnected",
            disconnected_at: new Date().toISOString(),
          })
          .eq("id", ws.id);
        if (disconnectErr) {
          console.error("[ingest-slack:disconnect] flip failed", {
            workspaceId: ws.id,
            message: disconnectErr.message,
          });
        } else {
          workspacesDisconnected += 1;
          console.warn("[ingest-slack:disconnect] workspace disconnected", {
            workspaceId: ws.id,
            teamId: ws.team_id,
            reason: err.message,
          });
        }
        continue;
      }

      // Other Slack API errors (rate-limit, transient network, etc.). Log
      // and continue — next firing retries. Do NOT advance watermark.
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[ingest-slack:workspace] transient error, will retry", {
        workspaceId: ws.id,
        teamId: ws.team_id,
        message: detail,
      });
      continue;
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log("[ingest-slack:done]", {
    workspacesProcessed,
    messagesUpserted,
    workspacesDisconnected,
    elapsedMs,
  });

  return NextResponse.json({
    ok: true,
    workspacesProcessed,
    messagesUpserted,
    workspacesDisconnected,
    elapsedMs,
  });
}
