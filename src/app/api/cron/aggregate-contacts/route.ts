import { NextRequest, NextResponse } from "next/server";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// POST /api/cron/aggregate-contacts
//
// Daily per-user rebuild of the personal CRM aggregate from existing
// ingested tables (emails, slack_messages, calendar_events). NO new
// third-party OAuth — everything we know about a person is derived from
// data we already have.
//
// Cadence: 0 2 * * * UTC (registered by migration 0021). Per-user serial
// loop, single-user-v0 scale.
//
// Inputs scanned per user:
//   - emails last 90d (from_address parsed → email + display_name; each
//     entry in to_addresses[] also counted as a "you reached out to X"
//     interaction so outbound-only contacts still surface).
//   - slack_messages last 90d (sender_id + sender_name).
//   - calendar_events last 90d past + 14d future (attendees jsonb — skip
//     self + organizer).
//
// Aggregate fields written:
//   - first_seen_at  = MIN(timestamp across all sources)
//   - last_seen_at   = MAX(timestamp across all sources)
//   - last_seen_source = source contributing the MAX
//   - total_interactions_lifetime = count across the 90d window
//   - total_interactions_30d      = count where ts ≥ now - 30d
//   - cadence_break_days  = floor((now - last_seen_at)/86400000) when > 28,
//                           else NULL  (Tab 1 D2)
//   - display_name = best non-null name encountered (email-source name
//                    preferred over slack-source name)
//   - aliases = jsonb of alternate email/slack ids seen (forward-compat)
//
// Preserved (NOT clobbered) on re-aggregate: manual_notes, manual_tags,
// archived. The cron uses .update() that lists only the aggregate columns
// so a user-edited notes/tags survives the nightly rebuild.
//
// Slack-only dedup (Tab 1 D1): when a contact is known only by Slack id
// (no email), the upsert is two-step — SELECT by primary_slack_user_id
// first; UPDATE if exists, INSERT if not. We can't use
// onConflict='user_id,primary_slack_user_id' because there's no UNIQUE on
// that combo (only user_id+primary_email has UNIQUE), so we route this
// path explicitly.

export const runtime = "nodejs";

// 90 days in ms — lookback window for source scans.
const LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;
// 30 days in ms — recent-interactions counter window.
const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
// 14 days in ms — future calendar lookahead.
const FUTURE_CALENDAR_MS = 14 * 24 * 60 * 60 * 1000;
// 28 days in days — cadence-break threshold (Tab 1 D2: only set when > 28).
const CADENCE_BREAK_THRESHOLD_DAYS = 28;

type UserRow = { id: string; email: string | null };

type EmailRow = {
  from_address: string | null;
  to_addresses: string[] | null;
  received_at: number;
};

type SlackRow = {
  sender_id: string;
  sender_name: string | null;
  received_at: number;
};

type CalendarRow = {
  start_at: string;
  attendees: unknown;
};

type Aggregate = {
  // identity
  email: string | null;
  slackId: string | null;
  // best display name encountered, with source priority for ties
  displayName: string | null;
  displayNameRank: number; // 3=email-source, 2=slack-source, 1=calendar-source, 0=fallback
  // timestamps in ms
  firstSeenMs: number;
  lastSeenMs: number;
  lastSeenSource: "email" | "slack" | "calendar";
  totalLifetime: number;
  total30d: number;
  // alternates seen
  altEmails: Set<string>;
  altSlackIds: Set<string>;
};

// Parse Gmail-style "Name <email@x.com>" or bare "email@x.com" into a
// normalized lowercased email + a best-effort display_name. Strips
// surrounding quotes off the name. Returns null email if the string
// contains no '@'.
function parseFromAddress(
  s: string | null,
): { email: string | null; displayName: string | null } {
  if (!s) return { email: null, displayName: null };
  const trimmed = s.trim();
  // "Name <email@x.com>" — name + angle-bracketed email. Name is OPTIONAL
  // (0+ chars) so this also matches "<email@x.com>" form. The previous
  // regex required at least 1 char before <, causing the bare-bracket
  // form to fall through and store "<email>" as the email — Bug A from
  // Tab 2's 10:57 UTC verification.
  const m = trimmed.match(/^(.*?)\s*<([^>]+)>$/);
  if (m) {
    const name = m[1].trim().replace(/^["']|["']$/g, "");
    const email = m[2].trim().toLowerCase();
    if (!email.includes("@")) return { email: null, displayName: null };
    return { email, displayName: name.length > 0 ? name : null };
  }
  // Bare email — no angle brackets. Reject if no @.
  const e = trimmed.toLowerCase();
  return { email: e.includes("@") ? e : null, displayName: null };
}

// Normalize an address from emails.to_addresses[] or calendar attendees
// into a clean lowercase email. Gmail sometimes stores `Name <email>` in
// the to_addresses array too — route through parseFromAddress so the
// angle-bracket form gets parsed, not stored raw. Bug A part 2.
function normalizeEmail(s: string | null | undefined): string | null {
  if (!s) return null;
  // If the input has angle brackets, parse it; else strip + lowercase.
  if (s.includes("<")) {
    return parseFromAddress(s).email;
  }
  const e = s.trim().toLowerCase();
  return e.includes("@") ? e : null;
}

// Bug B from Tab 2's 10:57 UTC verification: bot senders (LinkedIn job
// alerts, Google notifications, automated noreply addresses) dominate the
// dashboard "cadence flags" surface with useless signal. Skip them at
// the source — don't even create a contact row for these. Heuristic:
// match the local part (before @) against common bot prefixes and domains
// against common bot/transactional senders. Conservative — false negatives
// (real human emails passing through) are fine; false positives (skipping
// a real human) are not.
const BOT_LOCAL_PATTERNS: RegExp[] = [
  /noreply/i,
  /no-reply/i,
  /^notify[-.]/i,
  /[-.]alerts?@/i,
  /^alerts?@/i,
  /notifications?@/i,
  /^automated@/i,
  /^bounces@/i,
  /^mailer-daemon@/i,
  /^postmaster@/i,
  /^do-not-reply/i,
  /^donotreply/i,
];
const BOT_DOMAIN_SUFFIXES: string[] = [
  ".bounces.google.com",
  "@bounces.google.com",
  "@email.linkedin.com",
  "@info.linkedin.com",
  "@notifications.google.com",
];

function isBotSender(email: string | null): boolean {
  if (!email) return false;
  const lower = email.toLowerCase();
  for (const p of BOT_LOCAL_PATTERNS) {
    if (p.test(lower)) return true;
  }
  for (const suf of BOT_DOMAIN_SUFFIXES) {
    if (lower.endsWith(suf)) return true;
  }
  return false;
}

// Pull a display-name candidate string out of a value that might be null
// or empty. Trims whitespace; returns null when nothing usable.
function cleanName(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

// Get or create the aggregate row for a given identity key.
function getOrCreateAggregate(
  agg: Map<string, Aggregate>,
  key: string,
  seed: Partial<Aggregate>,
): Aggregate {
  const existing = agg.get(key);
  if (existing) return existing;
  const fresh: Aggregate = {
    email: seed.email ?? null,
    slackId: seed.slackId ?? null,
    displayName: seed.displayName ?? null,
    displayNameRank: seed.displayNameRank ?? 0,
    firstSeenMs: seed.firstSeenMs ?? Number.POSITIVE_INFINITY,
    lastSeenMs: seed.lastSeenMs ?? 0,
    lastSeenSource: seed.lastSeenSource ?? "email",
    totalLifetime: 0,
    total30d: 0,
    altEmails: new Set<string>(),
    altSlackIds: new Set<string>(),
  };
  agg.set(key, fresh);
  return fresh;
}

// Record one interaction against an aggregate. Updates first/last seen,
// counters, and display-name (when a higher-ranked name appears).
function recordInteraction(
  a: Aggregate,
  tsMs: number,
  source: "email" | "slack" | "calendar",
  nameCandidate: string | null,
  nameRank: number,
  nowMs: number,
): void {
  if (!Number.isFinite(tsMs)) return;
  if (tsMs < a.firstSeenMs) a.firstSeenMs = tsMs;
  if (tsMs > a.lastSeenMs) {
    a.lastSeenMs = tsMs;
    a.lastSeenSource = source;
  }
  a.totalLifetime += 1;
  if (tsMs >= nowMs - RECENT_WINDOW_MS) a.total30d += 1;
  if (nameCandidate && nameRank > a.displayNameRank) {
    a.displayName = nameCandidate;
    a.displayNameRank = nameRank;
  }
}

type CalendarAttendee = {
  email?: string;
  displayName?: string;
  self?: boolean;
  organizer?: boolean;
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
  const nowMs = startedAt;

  // --- Load all users ------------------------------------------------------
  const { data: userRows, error: usersErr } = await supabase
    .from("users")
    .select("id, email");

  if (usersErr) {
    console.error("[aggregate-contacts:load] users select failed", {
      message: usersErr.message,
    });
    return NextResponse.json(
      { error: "users_load_failed", detail: usersErr.message },
      { status: 500 },
    );
  }

  const users = (userRows ?? []) as UserRow[];
  if (users.length === 0) {
    console.log("[aggregate-contacts:load] no users");
    return NextResponse.json({
      ok: true,
      usersProcessed: 0,
      contactsUpserted: 0,
      elapsedMs: Date.now() - startedAt,
    });
  }

  // --- Per-user serial loop ------------------------------------------------
  let usersProcessed = 0;
  let contactsUpserted = 0;

  const sinceMs = nowMs - LOOKBACK_MS;
  const futureCalendarIso = new Date(nowMs + FUTURE_CALENDAR_MS).toISOString();
  const sinceCalendarIso = new Date(sinceMs).toISOString();

  for (const user of users) {
    try {
      // The aggregate map is keyed by email-lowercased, OR by `slack:<id>`
      // when no email is known. This guarantees we don't accidentally merge
      // a Slack id with a same-looking string email.
      const agg = new Map<string, Aggregate>();
      const userEmailLower = user.email ? user.email.trim().toLowerCase() : null;

      // --- 1. emails ----------------------------------------------------
      const { data: emailRows, error: emailErr } = await supabase
        .from("emails")
        .select("from_address, to_addresses, received_at")
        .eq("user_id", user.id)
        .gte("received_at", sinceMs);
      if (emailErr) {
        console.warn("[aggregate-contacts:emails] select failed, skipping user", {
          userId: user.id,
          message: emailErr.message,
        });
        continue;
      }
      for (const e of (emailRows ?? []) as EmailRow[]) {
        const tsMs = e.received_at;
        // Inbound: from_address → who emailed the user
        const { email: fromEmail, displayName: fromName } = parseFromAddress(
          e.from_address,
        );
        if (
          fromEmail &&
          fromEmail !== userEmailLower &&
          !isBotSender(fromEmail)
        ) {
          const a = getOrCreateAggregate(agg, fromEmail, { email: fromEmail });
          recordInteraction(a, tsMs, "email", cleanName(fromName), 3, nowMs);
        }
        // Outbound: each to_addresses[] entry → who the user emailed
        const toList = Array.isArray(e.to_addresses) ? e.to_addresses : [];
        for (const to of toList) {
          const toEmail = normalizeEmail(to);
          if (!toEmail) continue;
          if (toEmail === userEmailLower) continue; // skip self
          if (fromEmail && toEmail === fromEmail) continue; // already counted as inbound
          if (isBotSender(toEmail)) continue; // skip outbound to bot addresses too
          const a = getOrCreateAggregate(agg, toEmail, { email: toEmail });
          recordInteraction(a, tsMs, "email", null, 0, nowMs);
        }
      }

      // --- 2. slack_messages --------------------------------------------
      const { data: slackRows, error: slackErr } = await supabase
        .from("slack_messages")
        .select("sender_id, sender_name, received_at")
        .eq("user_id", user.id)
        .gte("received_at", sinceMs);
      if (slackErr) {
        console.warn("[aggregate-contacts:slack] select failed, skipping user", {
          userId: user.id,
          message: slackErr.message,
        });
        continue;
      }
      for (const s of (slackRows ?? []) as SlackRow[]) {
        if (!s.sender_id) continue;
        const key = `slack:${s.sender_id}`;
        const a = getOrCreateAggregate(agg, key, { slackId: s.sender_id });
        // Slack-source name ranks below email-source name.
        recordInteraction(
          a,
          s.received_at,
          "slack",
          cleanName(s.sender_name),
          2,
          nowMs,
        );
      }

      // --- 3. calendar_events -------------------------------------------
      // Window: 90d past + 14d future. We use start_at (timestamptz) here.
      const { data: calRows, error: calErr } = await supabase
        .from("calendar_events")
        .select("start_at, attendees")
        .eq("user_id", user.id)
        .gte("start_at", sinceCalendarIso)
        .lte("start_at", futureCalendarIso);
      if (calErr) {
        console.warn("[aggregate-contacts:calendar] select failed, skipping user", {
          userId: user.id,
          message: calErr.message,
        });
        continue;
      }
      for (const c of (calRows ?? []) as CalendarRow[]) {
        const startMs = Date.parse(c.start_at);
        if (!Number.isFinite(startMs)) continue;
        const attendees = Array.isArray(c.attendees)
          ? (c.attendees as CalendarAttendee[])
          : [];
        for (const att of attendees) {
          if (!att) continue;
          if (att.self) continue;
          if (att.organizer) continue;
          const attEmail = normalizeEmail(att.email);
          if (!attEmail) continue;
          if (attEmail === userEmailLower) continue;
          const a = getOrCreateAggregate(agg, attEmail, { email: attEmail });
          recordInteraction(
            a,
            startMs,
            "calendar",
            cleanName(att.displayName),
            1,
            nowMs,
          );
        }
      }

      // --- 4. Materialize and upsert -----------------------------------
      let upsertedThisUser = 0;
      for (const a of agg.values()) {
        if (a.totalLifetime === 0) continue;
        if (!Number.isFinite(a.firstSeenMs) || a.lastSeenMs === 0) continue;

        // Fallback display name: the email or slack id itself.
        const display =
          a.displayName ?? a.email ?? a.slackId ?? "(unknown)";
        const lastSeenAtIso = new Date(a.lastSeenMs).toISOString();
        const firstSeenAtIso = new Date(a.firstSeenMs).toISOString();
        const daysSince = Math.floor((nowMs - a.lastSeenMs) / 86400000);
        const cadenceBreak =
          daysSince > CADENCE_BREAK_THRESHOLD_DAYS ? daysSince : null;

        // Aggregate columns ONLY — manual_notes / manual_tags / archived
        // are intentionally OMITTED so user edits survive the rebuild.
        const aggregateCols = {
          display_name: display,
          aliases:
            a.altEmails.size + a.altSlackIds.size > 0
              ? {
                  emails: Array.from(a.altEmails),
                  slack_ids: Array.from(a.altSlackIds),
                }
              : null,
          first_seen_at: firstSeenAtIso,
          last_seen_at: lastSeenAtIso,
          last_seen_source: a.lastSeenSource,
          total_interactions_lifetime: a.totalLifetime,
          total_interactions_30d: a.total30d,
          cadence_break_days: cadenceBreak,
          updated_at: new Date().toISOString(),
        };

        if (a.email) {
          // Email-known path: use upsert with onConflict on the UNIQUE
          // constraint. PostgREST upsert is INSERT...ON CONFLICT DO UPDATE,
          // which only touches the columns in the payload — manual_* and
          // archived are not in aggregateCols so they're preserved.
          const { error: upsertErr } = await supabase
            .from("contacts")
            .upsert(
              {
                user_id: user.id,
                primary_email: a.email,
                primary_slack_user_id: a.slackId,
                ...aggregateCols,
              },
              {
                onConflict: "user_id,primary_email",
                ignoreDuplicates: false,
              },
            );
          if (upsertErr) {
            console.warn("[aggregate-contacts:upsert-email] failed", {
              userId: user.id,
              email: a.email,
              message: upsertErr.message,
            });
            continue;
          }
          upsertedThisUser += 1;
        } else if (a.slackId) {
          // Slack-only path (Tab 1 D1 two-step upsert): we can't use
          // postgrest onConflict because there's no UNIQUE on
          // (user_id, primary_slack_user_id). SELECT first; UPDATE if
          // exists, INSERT if not.
          const { data: existing, error: selErr } = await supabase
            .from("contacts")
            .select("id")
            .eq("user_id", user.id)
            .is("primary_email", null)
            .eq("primary_slack_user_id", a.slackId)
            .maybeSingle();
          if (selErr) {
            console.warn("[aggregate-contacts:slack-only-select] failed", {
              userId: user.id,
              slackId: a.slackId,
              message: selErr.message,
            });
            continue;
          }
          if (existing) {
            const { error: updErr } = await supabase
              .from("contacts")
              .update(aggregateCols)
              .eq("id", existing.id);
            if (updErr) {
              console.warn("[aggregate-contacts:slack-only-update] failed", {
                userId: user.id,
                slackId: a.slackId,
                message: updErr.message,
              });
              continue;
            }
          } else {
            const { error: insErr } = await supabase
              .from("contacts")
              .insert({
                user_id: user.id,
                primary_email: null,
                primary_slack_user_id: a.slackId,
                ...aggregateCols,
              });
            if (insErr) {
              console.warn("[aggregate-contacts:slack-only-insert] failed", {
                userId: user.id,
                slackId: a.slackId,
                message: insErr.message,
              });
              continue;
            }
          }
          upsertedThisUser += 1;
        }
      }

      usersProcessed += 1;
      contactsUpserted += upsertedThisUser;
      console.log("[aggregate-contacts:user] ok", {
        userId: user.id,
        aggregateCount: agg.size,
        upserted: upsertedThisUser,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[aggregate-contacts:user] transient error, continuing", {
        userId: user.id,
        message: detail,
      });
      continue;
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log("[aggregate-contacts:done]", {
    usersProcessed,
    contactsUpserted,
    elapsedMs,
  });

  return NextResponse.json({
    ok: true,
    usersProcessed,
    contactsUpserted,
    elapsedMs,
  });
}
