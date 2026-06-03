import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { resolveUser } from "@/lib/auth/resolveUser";
import { getGoogleAccessToken } from "@/lib/clerk";
import {
  listInboxIdsLastNDays,
  getEmailsByIds,
  type NormalizedEmail,
} from "@/lib/gmail";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import {
  BACKFILL_EMAIL_CAP,
  FIRST_INGEST_FULL,
  INITIAL_LOOKBACK_DAYS,
  STALE_BUFFER,
} from "@/lib/limits";

// POST /api/ingest-emails
//
// Two auth paths (resolveUser):
//   - Clerk session (browser dashboard)
//   - CRON_SECRET + body.user_email (CLI / cron)
//
// Hybrid first-ingest split:
//   - list up to BACKFILL_EMAIL_CAP message IDs from the inbox (~700ms)
//   - fully fetch the FIRST_INGEST_FULL most-recent (Gmail returns newest
//     first), insert with status='pending' so the classifier picks them up
//   - queue the remainder as stubs with status='pending_fetch' so the
//     body-fetch cron route fills them in 5-at-a-time chunks
//
// Voice-corpus init: if no voice samples exist yet, waitUntil-trigger the
// internal init route; that route fetches sent mail, segments the first 10
// inline, and marks the rest as pending_segment for cron.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = await resolveUser(req);
  if (!auth.ok) return auth.response;
  const { supabaseUserId, clerkUserId } = auth.user;

  // --- Gmail access token ---------------------------------------------------
  let token: string | null;
  try {
    token = await getGoogleAccessToken(clerkUserId);
  } catch (err) {
    console.error("[ingestEmails:token] fetch failed", {
      clerkUserId,
      message: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "token_fetch_failed" },
      { status: 502 },
    );
  }
  if (!token) {
    return NextResponse.json({ error: "no_google_token" }, { status: 412 });
  }

  // --- List IDs from Gmail --------------------------------------------------
  let ids;
  try {
    ids = await listInboxIdsLastNDays(
      token,
      INITIAL_LOOKBACK_DAYS,
      BACKFILL_EMAIL_CAP,
    );
  } catch (err) {
    console.error("[ingestEmails:list] gmail list failed", {
      clerkUserId,
      message: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "gmail_list_failed" },
      { status: 502 },
    );
  }
  if (ids.length === 0) {
    console.log("[ingestEmails:done] empty inbox window", {
      userId: supabaseUserId,
      lookbackDays: INITIAL_LOOKBACK_DAYS,
    });
    return NextResponse.json({
      ingested: 0,
      fullCount: 0,
      stubCount: 0,
      prunedCount: 0,
    });
  }

  // --- Split: first N fully fetched, rest queued as stubs -------------------
  const fullIds = ids.slice(0, FIRST_INGEST_FULL);
  const stubIds = ids.slice(FIRST_INGEST_FULL);

  let fullEmails: NormalizedEmail[] = [];
  try {
    fullEmails = await getEmailsByIds(token, fullIds, 10);
  } catch (err) {
    console.error("[ingestEmails:get] gmail get failed", {
      clerkUserId,
      message: err instanceof Error ? err.message : String(err),
      attemptedCount: fullIds.length,
    });
    return NextResponse.json(
      { error: "gmail_get_failed" },
      { status: 502 },
    );
  }

  const supabase = makeSupabaseServerClient();

  // --- Insert fully-fetched rows (idempotent on (user_id, gmail_message_id))
  let fullInserted = 0;
  if (fullEmails.length > 0) {
    const fullRows = fullEmails.map((e) => ({
      user_id: supabaseUserId,
      gmail_message_id: e.messageId,
      thread_id: e.threadId,
      from_address: e.fromAddress,
      to_addresses: e.toAddresses,
      subject: e.subject,
      snippet: e.snippet,
      received_at: e.receivedAt.getTime(),
      status: "pending" as const,
    }));
    const { count, error } = await supabase
      .from("emails")
      .upsert(fullRows, {
        onConflict: "user_id,gmail_message_id",
        ignoreDuplicates: true,
        count: "exact",
      });
    if (error) {
      console.error("[ingestEmails:insert-full] failed", {
        userId: supabaseUserId,
        rowCount: fullRows.length,
        message: error.message,
      });
      return NextResponse.json(
        { error: "insert_full_failed", detail: error.message },
        { status: 500 },
      );
    }
    fullInserted = count ?? 0;
  }

  // --- Queue stubs (status='pending_fetch') ---------------------------------
  let stubInserted = 0;
  if (stubIds.length > 0) {
    const stubRows = stubIds.map((id) => ({
      user_id: supabaseUserId,
      gmail_message_id: id.messageId,
      thread_id: id.threadId,
      status: "pending_fetch" as const,
      to_addresses: [] as string[],
    }));
    const { count, error } = await supabase
      .from("emails")
      .upsert(stubRows, {
        onConflict: "user_id,gmail_message_id",
        ignoreDuplicates: true,
        count: "exact",
      });
    if (error) {
      console.error("[ingestEmails:insert-stub] failed", {
        userId: supabaseUserId,
        rowCount: stubRows.length,
        message: error.message,
      });
      return NextResponse.json(
        { error: "insert_stub_failed", detail: error.message },
        { status: 500 },
      );
    }
    stubInserted = count ?? 0;
  }

  // --- last_ingested_at -----------------------------------------------------
  {
    const { error } = await supabase
      .from("users")
      .update({ last_ingested_at: Date.now() })
      .eq("id", supabaseUserId);
    if (error) {
      // Non-fatal — log and continue. Worst case the dashboard's "last
      // ingested" timestamp is stale.
      console.error("[ingestEmails:last-ingested] update failed", {
        userId: supabaseUserId,
        message: error.message,
      });
    }
  }

  // --- Prune if active pool drifted past CAP + BUFFER -----------------------
  // Counts only active, non-stub rows. A prune failure must never block a
  // successful ingest, so wrapped in its own try/catch.
  let prunedCount = 0;
  try {
    const { count: activeCount, error: countErr } = await supabase
      .from("emails")
      .select("id", { count: "exact", head: true })
      .eq("user_id", supabaseUserId)
      .eq("archived_stale", false)
      .neq("status", "pending_fetch");
    if (countErr) throw countErr;
    const active = activeCount ?? 0;
    if (active > BACKFILL_EMAIL_CAP + STALE_BUFFER) {
      const overflow = active - BACKFILL_EMAIL_CAP;
      const { data: toStale, error: selectErr } = await supabase
        .from("emails")
        .select("id")
        .eq("user_id", supabaseUserId)
        .eq("archived_stale", false)
        .neq("status", "pending_fetch")
        .order("received_at", { ascending: true })
        .limit(overflow);
      if (selectErr) throw selectErr;
      if (toStale && toStale.length > 0) {
        const { error: updateErr } = await supabase
          .from("emails")
          .update({ archived_stale: true })
          .in(
            "id",
            toStale.map((r) => r.id),
          );
        if (updateErr) throw updateErr;
        prunedCount = toStale.length;
      }
      console.log("[ingestEmails:prune] applied", {
        userId: supabaseUserId,
        activeBefore: active,
        prunedCount,
      });
    } else {
      console.log("[ingestEmails:prune] no-op", {
        userId: supabaseUserId,
        active,
        threshold: BACKFILL_EMAIL_CAP + STALE_BUFFER,
      });
    }
  } catch (err) {
    console.error("[ingestEmails:prune] failed", {
      userId: supabaseUserId,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // --- Voice-corpus init (waitUntil) ----------------------------------------
  // Fires only when this user has zero voice samples. The init route does
  // its own chunked split (fetch sent + segment first 10 inline, mark rest
  // pending_segment for cron). Failure logged inside the called route.
  try {
    const { count: voiceCount, error: voiceErr } = await supabase
      .from("voice_samples")
      .select("id", { count: "exact", head: true })
      .eq("user_id", supabaseUserId);
    if (voiceErr) throw voiceErr;
    if ((voiceCount ?? 0) === 0) {
      const cronSecret = process.env.CRON_SECRET;
      const baseUrl = resolveBaseUrl(req);
      if (cronSecret && baseUrl) {
        waitUntil(
          fetch(`${baseUrl}/api/internal/voice-init`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${cronSecret}`,
            },
            body: JSON.stringify({ user_email: auth.user.email }),
          }).then(async (res) => {
            if (!res.ok) {
              // Per CONVENTIONS rule (d): don't log response bodies, even
              // from our own internal routes — they might one day relay
              // fetched data. Status + handler id is enough for triage.
              console.error("[ingestEmails:voice-trigger] non-200", {
                userId: supabaseUserId,
                status: res.status,
              });
            } else {
              console.log("[ingestEmails:voice-trigger] dispatched", {
                userId: supabaseUserId,
              });
            }
          }).catch((err) => {
            console.error("[ingestEmails:voice-trigger] fetch threw", {
              userId: supabaseUserId,
              message: err instanceof Error ? err.message : String(err),
            });
          }),
        );
      } else {
        console.warn("[ingestEmails:voice-trigger] skipped", {
          userId: supabaseUserId,
          reason: !cronSecret ? "no_cron_secret" : "no_base_url",
        });
      }
    }
  } catch (err) {
    console.error("[ingestEmails:voice-check] failed", {
      userId: supabaseUserId,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  console.log("[ingestEmails:done] success", {
    userId: supabaseUserId,
    fullInserted,
    stubInserted,
    prunedCount,
    totalListed: ids.length,
  });

  return NextResponse.json({
    ingested: fullInserted + stubInserted,
    fullCount: fullInserted,
    stubCount: stubInserted,
    prunedCount,
  });
}

// Resolves the absolute base URL for server-to-server fetches. Vercel sets
// VERCEL_URL automatically; locally we fall back to the request's origin
// so dev work doesn't need an extra env var.
function resolveBaseUrl(req: NextRequest): string | null {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  const origin = req.nextUrl.origin;
  if (origin) return origin;
  return null;
}
