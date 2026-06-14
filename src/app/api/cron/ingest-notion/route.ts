import { NextRequest, NextResponse } from "next/server";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import {
  NotionAuthError,
  searchPages,
  fetchPageBlocks,
  type NotionSearchResult,
} from "@/lib/notion/client";

// POST /api/cron/ingest-notion
//
// Per-firing per-integration ingest of Notion page history. Mirror of
// ingest-slack in shape (cron-gated, service-role Supabase, JSON summary),
// but the unit of work is per-integration serial loops rather than a
// queue-claim chunk.
//
// Single-user-v0 simplification: integrations are processed serially, AND
// pages within an integration are walked serially too — Notion's API is
// tightly rate-limited (avg 3 req/sec per integration) and parallelizing
// would just burn the budget for marginal wall-clock savings. When v1 adds
// multi-tenant load, this becomes a chunked claim pattern (same RPC shape
// as claim_pending_classify_notion_chunk).
//
// Lookback rules:
//   - last_polled_at IS NULL → poll the last 7 days (first-poll cold start,
//     per Flag A).
//   - last_polled_at SET     → poll since last_polled_at.
// Notion's /v1/search filter on last_edited_time uses ISO 8601 strings.
//
// Caps (per Flag C): 100 pages max per integration per firing. Pagination
// uses Notion's start_cursor.
//
// Idempotency: bulk upsert is on UNIQUE(integration_id, page_id) with
// ignoreDuplicates=false → re-ingestion of the same page refreshes title /
// snippet / last_edited_at / raw (an edited page should reflect its latest
// content in the dashboard). A partial-failure re-poll picks the same window
// and refreshes rows; last_polled_at only advances after a successful
// integration pass so a mid-integration failure rewinds to the last good
// watermark on the next firing.
//
// Auth-error handling: a NotionAuthError on ANY API call for an integration
// flips that integration to status='disconnected', stamps disconnected_at,
// and the loop continues with the next integration. The hourly cron skips
// disconnected integrations via the notion_integrations_active partial index.
//
// Snippet shape (per Flag B): title + first 500 chars of body. fetchPageBlocks
// returns the 500-char-sliced body text; we concat as `${title}\n\n${body}`
// then re-slice to 500 for the final hard cap.

export const runtime = "nodejs";

// 7 days in ms — Notion last_edited_time is ISO; we compute the floor as ms
// then convert to ISO for the API call.
const FIRST_POLL_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
// Hard cap on pages per integration per firing (Flag C). Prevents a runaway
// workspace from monopolizing a single cron run.
const MAX_PAGES_PER_INTEGRATION = 100;
// Hard cap on the final snippet length stored in the DB.
const SNIPPET_MAX_LEN = 500;
// Hard cap on title length stored in the DB (titles are bounded by Notion at
// ~2000 chars but we slice defensively).
const TITLE_MAX_LEN = 500;

type IntegrationRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  last_polled_at: string | null;
};

type CredentialRow = {
  integration_id: string;
  access_token: string;
};

type InsertRow = {
  user_id: string;
  integration_id: string;
  page_id: string;
  title: string;
  snippet: string;
  last_edited_at: string;
  url: string | null;
  received_at: number;
  raw: unknown;
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

  // --- Load active integrations + their credentials ------------------------
  const { data: intRows, error: intErr } = await supabase
    .from("notion_integrations")
    .select("id, user_id, workspace_id, last_polled_at")
    .eq("status", "active");

  if (intErr) {
    console.error("[ingest-notion:load] integrations select failed", {
      message: intErr.message,
    });
    return NextResponse.json(
      { error: "integrations_load_failed", detail: intErr.message },
      { status: 500 },
    );
  }

  const integrations = (intRows ?? []) as IntegrationRow[];

  if (integrations.length === 0) {
    console.log("[ingest-notion:load] no active integrations");
    return NextResponse.json({
      ok: true,
      integrationsProcessed: 0,
      pagesUpserted: 0,
      integrationsDisconnected: 0,
      integrationsSkippedNoToken: 0,
      elapsedMs: Date.now() - startedAt,
    });
  }

  const integrationIds = integrations.map((i) => i.id);
  const { data: credRows, error: credErr } = await supabase
    .from("notion_credentials")
    .select("integration_id, access_token")
    .in("integration_id", integrationIds);

  if (credErr) {
    console.error("[ingest-notion:load] credentials select failed", {
      message: credErr.message,
    });
    return NextResponse.json(
      { error: "credentials_load_failed", detail: credErr.message },
      { status: 500 },
    );
  }

  const tokenByIntegration = new Map<string, string>();
  for (const c of (credRows ?? []) as CredentialRow[]) {
    if (c.access_token) tokenByIntegration.set(c.integration_id, c.access_token);
  }

  // --- Per-integration serial loop ----------------------------------------
  let integrationsProcessed = 0;
  let pagesUpserted = 0;
  let integrationsDisconnected = 0;
  let integrationsSkippedNoToken = 0;

  for (const integration of integrations) {
    const accessToken = tokenByIntegration.get(integration.id);
    if (!accessToken) {
      // Either credentials row missing entirely, OR row exists with empty
      // access_token. Defensive — should not happen if OAuth callback always
      // inserts both rows in the same transaction. Skip and log; integration
      // stays status='active' so user can reconnect without manual repair.
      console.warn("[ingest-notion:integration] missing access_token, needs reconnect", {
        integrationId: integration.id,
        workspaceId: integration.workspace_id,
      });
      integrationsSkippedNoToken += 1;
      continue;
    }

    // Compute `since` as ISO 8601 for Notion's last_edited_time filter.
    const sinceMs = integration.last_polled_at
      ? new Date(integration.last_polled_at).getTime()
      : Date.now() - FIRST_POLL_LOOKBACK_MS;
    const sinceIso = new Date(sinceMs).toISOString();

    try {
      // --- 1. Search pages since the watermark --------------------------
      const results = await searchPages(
        accessToken,
        sinceIso,
        MAX_PAGES_PER_INTEGRATION,
      );

      // --- 2. For each page (serial), fetch body blocks + build snippet
      const insertRows: InsertRow[] = [];
      for (const result of results) {
        // Defensive: Notion search should respect since via filter, but if
        // the API ever returns an older page (clock skew, pagination edge),
        // drop it so we don't redo classification work for unchanged rows.
        const lastEditedMs = new Date(result.lastEditedTime).getTime();
        if (Number.isFinite(lastEditedMs) && lastEditedMs < sinceMs) continue;

        let bodySnippet = "";
        try {
          bodySnippet = await fetchPageBlocks(accessToken, result.pageId);
        } catch (err) {
          if (err instanceof NotionAuthError) throw err;
          // Block-fetch failure on a single page is non-fatal — log and
          // skip just that page so we don't lose the entire workspace pass.
          const detail = err instanceof Error ? err.message : String(err);
          console.warn("[ingest-notion:blocks] fetch failed, skipping page", {
            integrationId: integration.id,
            pageId: result.pageId,
            message: detail,
          });
          continue;
        }

        const title = (result.title ?? "").trim();
        const body = (bodySnippet ?? "").trim();
        // Drop pages where both title and body are empty — nothing to
        // classify, no value in surfacing them in the dashboard.
        if (title.length === 0 && body.length === 0) continue;

        const snippet = `${title}\n\n${body}`.slice(0, SNIPPET_MAX_LEN);

        insertRows.push({
          user_id: integration.user_id,
          integration_id: integration.id,
          page_id: result.pageId,
          title: title.slice(0, TITLE_MAX_LEN),
          snippet,
          last_edited_at: result.lastEditedTime,
          url: result.url ?? null,
          received_at: Number.isFinite(lastEditedMs) ? lastEditedMs : Date.now(),
          raw: result.raw,
        });
      }

      // --- 3. Bulk upsert (refresh on conflict) -------------------------
      // ignoreDuplicates=false → on UNIQUE(integration_id, page_id) collision
      // we REFRESH title/snippet/last_edited_at/raw so edits to an already-
      // ingested page reflect in the dashboard. Note this does NOT reset
      // classification — an edited page keeps its prior classification until
      // a separate reclassify path (out of scope here) flips it.
      let upserted = 0;
      if (insertRows.length > 0) {
        const { error: insertErr } = await supabase
          .from("notion_pages")
          .upsert(insertRows, {
            onConflict: "integration_id,page_id",
            ignoreDuplicates: false,
          });
        if (insertErr) {
          // Treat as transient — don't disconnect, don't advance watermark.
          // Next firing retries the same window.
          console.error("[ingest-notion:insert] upsert failed", {
            integrationId: integration.id,
            rows: insertRows.length,
            message: insertErr.message,
          });
          continue;
        }
        upserted = insertRows.length;
      }

      // --- 4. Advance watermark -----------------------------------------
      // Stamp the watermark to (firing start - 60s overlap). The overlap
      // covers the small race where a page is edited in Notion between our
      // search call and now() — next firing's `since` includes it, and the
      // UNIQUE(integration_id, page_id) constraint dedupes (with refresh)
      // any pages we already ingested in this firing.
      const watermarkIso = new Date(startedAt - 60_000).toISOString();
      const { error: wmErr } = await supabase
        .from("notion_integrations")
        .update({ last_polled_at: watermarkIso })
        .eq("id", integration.id);
      if (wmErr) {
        console.error("[ingest-notion:watermark] update failed", {
          integrationId: integration.id,
          message: wmErr.message,
        });
        // Upserts already landed (idempotent on next firing anyway); count
        // the integration as processed but log loudly.
      }

      integrationsProcessed += 1;
      pagesUpserted += upserted;
      console.log("[ingest-notion:integration] ok", {
        integrationId: integration.id,
        workspaceId: integration.workspace_id,
        searchResults: results.length,
        eligible: insertRows.length,
        upserted,
        sinceIso,
      });
    } catch (err) {
      if (err instanceof NotionAuthError) {
        // Token revoked / integration uninstalled / unauthorized. Flip
        // integration to disconnected so the next cron skips it. Reconnect
        // flow (out of scope here) is responsible for flipping back.
        const { error: disconnectErr } = await supabase
          .from("notion_integrations")
          .update({
            status: "disconnected",
            disconnected_at: new Date().toISOString(),
          })
          .eq("id", integration.id);
        if (disconnectErr) {
          console.error("[ingest-notion:disconnect] flip failed", {
            integrationId: integration.id,
            message: disconnectErr.message,
          });
        } else {
          integrationsDisconnected += 1;
          console.warn("[ingest-notion:disconnect] integration disconnected", {
            integrationId: integration.id,
            workspaceId: integration.workspace_id,
            reason: err.message,
          });
        }
        continue;
      }

      // Other Notion API errors (rate-limit, transient network, etc.). Log
      // and continue — next firing retries. Do NOT advance watermark.
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[ingest-notion:integration] transient error, will retry", {
        integrationId: integration.id,
        workspaceId: integration.workspace_id,
        message: detail,
      });
      continue;
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log("[ingest-notion:done]", {
    integrationsProcessed,
    pagesUpserted,
    integrationsDisconnected,
    integrationsSkippedNoToken,
    elapsedMs,
  });

  return NextResponse.json({
    ok: true,
    integrationsProcessed,
    pagesUpserted,
    integrationsDisconnected,
    integrationsSkippedNoToken,
    elapsedMs,
  });
}

// Suppress unused-type warning for NotionSearchResult: it's only referenced
// indirectly via searchPages's return type. Tree-shake-safe.
export type { NotionSearchResult };
