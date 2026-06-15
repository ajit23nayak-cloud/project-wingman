import { NextRequest, NextResponse } from "next/server";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import {
  GoogleCalendarAuthError,
  listSelectedCalendars,
  listEvents,
  type GoogleCalendarEvent,
} from "@/lib/google/calendar/client";
import { refreshAccessToken } from "@/lib/google/calendar/oauth";

// POST /api/cron/ingest-calendar
//
// Per-firing per-user ingest of Google Calendar events. Mirror of
// ingest-slack / ingest-notion in shape (cron-gated, service-role Supabase,
// JSON summary), but the unit of work is per-user serial loops over
// calendar_credentials rows rather than a queue-claim chunk.
//
// Single-user-v0 simplification: credentials rows are processed serially.
// When v1 adds multi-tenant load this becomes a chunked claim pattern (same
// RPC shape as claim_pending_classify_calendar_chunk).
//
// Time window per poll (per Tab 2 lock):
//   - timeMin = now - 1 day  (captures late-decision changes on
//     just-completed meetings — post-mortem signal)
//   - timeMax = now + 14 days (~2 sprints of lead-time for upcoming-meeting
//     prep surface)
// The window is the same every firing — we are NOT using a since-watermark
// like Slack/Notion. Idempotency comes from the UNIQUE(user_id,
// google_event_id) constraint + upsert refresh-on-conflict.
//
// Idempotency: bulk upsert is on UNIQUE(user_id, google_event_id) with
// ignoreDuplicates=false → re-ingestion of the same event REFRESHES
// title/start/end/attendees/etc. This is essential for the calendar use case:
// a last-minute reschedule or accept needs to reflect in the dashboard on
// the very next firing.
//
// Auth-error handling: a GoogleCalendarAuthError on ANY call for a user (or
// a refreshAccessToken failure) flips that user's credentials to
// status='disconnected', stamps disconnected_at, and the loop continues
// with the next user. The 15-min cron skips disconnected users via the
// status='active' filter in the initial SELECT.
//
// Per-calendar error isolation: errors fetching events for ONE calendar
// (5xx, rate-limit 403) log and skip that calendar, but the user's other
// calendars still get processed. No watermark to advance, so next firing
// naturally retries the failed calendar within its own window.

export const runtime = "nodejs";

// Window bounds per Tab 2 spec.
const PAST_WINDOW_MS = 1 * 24 * 60 * 60 * 1000;
const FUTURE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
// Refresh access_token if it expires within this many ms of now. 5 min gives
// us comfortable headroom against clock skew + the time the rest of the
// firing takes to actually use the token.
const TOKEN_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

type CredentialRow = {
  user_id: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string;
  scope: string;
};

type CalendarEventInsertRow = {
  user_id: string;
  google_calendar_id: string;
  google_event_id: string;
  ical_uid: string | null;
  title: string;
  description: string | null;
  start_at: string;
  end_at: string;
  all_day: boolean;
  location: string | null;
  conference_link: string | null;
  conference_type: string | null;
  organizer_email: string | null;
  organizer_self: boolean;
  attendees: unknown;
  attendee_count: number;
  external_attendee_count: number;
  user_response_status: string | null;
  event_status: "confirmed" | "tentative" | "cancelled";
  raw: GoogleCalendarEvent;
  received_at: number;
};

// Extract a video-conference link from a Google event. Priority order per
// Tab 2 Flag 8:
//   1. event.conferenceData.entryPoints[] (native Meet/Zoom integration)
//   2. event.hangoutLink (legacy Google Meet)
//   3. URL regex match in event.description (manually-pasted Zoom/Meet/
//      Teams/Whereby/Around links)
function extractConferenceLink(
  event: GoogleCalendarEvent,
): { conferenceLink: string | null; conferenceType: string | null } {
  // Priority 1: structured conferenceData. Agent B's GoogleCalendarEvent
  // types conferenceData as `unknown` (kept loose for v0 because Google's
  // shape evolves and we only care about a narrow read), so narrow here.
  type ConferenceData = {
    entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
    conferenceSolution?: { name?: string };
  };
  const cd = event.conferenceData as ConferenceData | undefined;
  const entryPoints = cd?.entryPoints;
  if (Array.isArray(entryPoints) && entryPoints.length > 0) {
    const videoEntry = entryPoints.find(
      (ep) => ep?.entryPointType === "video",
    );
    if (videoEntry?.uri) {
      const solution = cd?.conferenceSolution?.name ?? "Meet";
      return { conferenceLink: videoEntry.uri, conferenceType: solution };
    }
  }
  // Priority 2: legacy hangoutLink.
  if (event.hangoutLink) {
    return { conferenceLink: event.hangoutLink, conferenceType: "Google Meet" };
  }
  // Priority 3: URL regex in description. Order matters — pattern listed
  // first wins when multiple links appear in the description (rare but
  // possible — e.g. Zoom link with a fallback Meet link in the body).
  const desc = event.description ?? "";
  const patterns: Array<[RegExp, string]> = [
    [/https?:\/\/[a-z0-9.-]*\.zoom\.us\/\S+/i, "Zoom"],
    [/https?:\/\/meet\.google\.com\/\S+/i, "Google Meet"],
    [/https?:\/\/teams\.microsoft\.com\/\S+/i, "Microsoft Teams"],
    [/https?:\/\/[a-z0-9.-]*\.whereby\.com\/\S+/i, "Whereby"],
    [/https?:\/\/app\.around\.co\/\S+/i, "Around"],
  ];
  for (const [re, name] of patterns) {
    const m = desc.match(re);
    if (m) return { conferenceLink: m[0], conferenceType: name };
  }
  return { conferenceLink: null, conferenceType: null };
}

// Derive the @domain portion of a user's email (for external-attendee
// counting). Returns null for malformed addresses — we fall back to
// "everyone non-self non-organizer is external" in that case.
function deriveEmailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

// Normalize Google's event.status into our checked event_status enum. Google
// returns 'confirmed' | 'tentative' | 'cancelled' (lowercase). Any unknown
// value defaults to 'confirmed' for safety.
function normalizeEventStatus(
  status: string | undefined,
): "confirmed" | "tentative" | "cancelled" {
  if (status === "cancelled") return "cancelled";
  if (status === "tentative") return "tentative";
  return "confirmed";
}

// Normalize the user's responseStatus from attendees[].responseStatus.
// Google returns 'accepted' | 'tentative' | 'declined' | 'needsAction'.
// Any unknown value is dropped to null (matches the check constraint).
function normalizeResponseStatus(status: string | undefined): string | null {
  if (
    status === "accepted" ||
    status === "tentative" ||
    status === "declined" ||
    status === "needsAction"
  ) {
    return status;
  }
  return null;
}

export async function POST(req: NextRequest) {
  // --- Auth ----------------------------------------------------------------
  const expected = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!expected || authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = makeSupabaseServerClient();
  const startedAt = Date.now();

  // --- Load active credentials --------------------------------------------
  const { data: credRows, error: credErr } = await supabase
    .from("calendar_credentials")
    .select("user_id, access_token, refresh_token, token_expires_at, scope")
    .eq("status", "active");

  if (credErr) {
    console.error("[ingest-calendar:load] credentials select failed", {
      message: credErr.message,
    });
    return NextResponse.json(
      { error: "credentials_load_failed", detail: credErr.message },
      { status: 500 },
    );
  }

  const credentials = (credRows ?? []) as CredentialRow[];

  if (credentials.length === 0) {
    console.log("[ingest-calendar:load] no active credentials");
    return NextResponse.json({
      ok: true,
      usersProcessed: 0,
      eventsUpserted: 0,
      usersDisconnected: 0,
      usersSkippedNoCreds: 0,
      elapsedMs: Date.now() - startedAt,
    });
  }

  // --- Per-user serial loop ------------------------------------------------
  let usersProcessed = 0;
  let eventsUpserted = 0;
  let usersDisconnected = 0;
  const usersSkippedNoCreds = 0; // reserved for v1 (e.g. revoked refresh_token)

  // Window is fixed per firing — same window for all users this tick.
  const nowMs = Date.now();
  const timeMinIso = new Date(nowMs - PAST_WINDOW_MS).toISOString();
  const timeMaxIso = new Date(nowMs + FUTURE_WINDOW_MS).toISOString();

  for (const cred of credentials) {
    try {
      // --- 1. Look up user's email domain for external-attendee counting -
      // One extra SELECT per user per firing — negligible. Used to compute
      // external_attendee_count without storing the user's email on every
      // event row.
      const { data: userRow, error: userErr } = await supabase
        .from("users")
        .select("email")
        .eq("id", cred.user_id)
        .maybeSingle();
      if (userErr) {
        // Non-fatal — fall through with null domain. external count then
        // includes anyone non-self/non-organizer, which is an
        // over-estimate but better than skipping the user.
        console.warn("[ingest-calendar:user] email lookup failed", {
          userId: cred.user_id,
          message: userErr.message,
        });
      }
      const userEmail = (userRow?.email as string | undefined) ?? null;
      const userDomain = deriveEmailDomain(userEmail);

      // --- 2. Refresh access_token if expiring soon ---------------------
      let accessToken = cred.access_token;
      const expiresMs = new Date(cred.token_expires_at).getTime();
      if (
        !Number.isFinite(expiresMs) ||
        expiresMs - Date.now() < TOKEN_REFRESH_THRESHOLD_MS
      ) {
        try {
          const refreshed = await refreshAccessToken(cred.refresh_token);
          accessToken = refreshed.accessToken;
          // Persist the new token (and possibly new refresh_token if Google
          // rotated it — they sometimes do on long-lived refresh tokens).
          const updatePayload: Record<string, unknown> = {
            access_token: refreshed.accessToken,
            token_expires_at: refreshed.expiresAt.toISOString(),
            updated_at: new Date().toISOString(),
          };
          if (refreshed.refreshToken) {
            updatePayload.refresh_token = refreshed.refreshToken;
          }
          // Race guard: scope the update to (user_id, refresh_token) so a
          // mid-firing re-OAuth that replaced the credentials row doesn't
          // get its fresh tokens clobbered by our stale in-memory ones.
          const { error: tokUpdErr } = await supabase
            .from("calendar_credentials")
            .update(updatePayload)
            .eq("user_id", cred.user_id)
            .eq("refresh_token", cred.refresh_token);
          if (tokUpdErr) {
            // Non-fatal — we already have the fresh token in-memory for
            // this firing. Next firing's refresh check just runs again.
            console.warn("[ingest-calendar:token] persist refreshed token failed", {
              userId: cred.user_id,
              message: tokUpdErr.message,
            });
          }
        } catch (refreshErr) {
          // Refresh failure is an unrecoverable auth state — flip
          // disconnected and skip this user. Reconnect flow re-grants and
          // re-inserts credentials.
          const detail =
            refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
          console.warn("[ingest-calendar:token] refresh failed, disconnecting", {
            userId: cred.user_id,
            message: detail,
          });
          // Race guard: only flip the row we read. If user re-OAuth'd
          // mid-firing, refresh_token differs and we leave their fresh
          // row alone.
          const { error: disconnectErr } = await supabase
            .from("calendar_credentials")
            .update({
              status: "disconnected",
              disconnected_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("user_id", cred.user_id)
            .eq("refresh_token", cred.refresh_token);
          if (disconnectErr) {
            console.error("[ingest-calendar:disconnect] flip failed", {
              userId: cred.user_id,
              message: disconnectErr.message,
            });
          } else {
            usersDisconnected += 1;
          }
          continue;
        }
      }

      // --- 3. List selected calendars -----------------------------------
      const calendars = await listSelectedCalendars(accessToken);

      // --- 4. For each calendar, fetch events; collect insert rows -----
      const insertRows: CalendarEventInsertRow[] = [];
      for (const cal of calendars) {
        let events: GoogleCalendarEvent[] = [];
        try {
          events = await listEvents(accessToken, cal.id, timeMinIso, timeMaxIso);
        } catch (calErr) {
          if (calErr instanceof GoogleCalendarAuthError) {
            // Auth failure mid-loop — re-throw to the outer catch so we
            // disconnect the user once, not per-calendar.
            throw calErr;
          }
          // Other errors (5xx, rate-limit 403) — skip just this calendar,
          // continue with the user's other calendars. Next firing retries.
          const detail =
            calErr instanceof Error ? calErr.message : String(calErr);
          console.warn("[ingest-calendar:calendar] list events failed, skipping calendar", {
            userId: cred.user_id,
            calendarId: cal.id,
            message: detail,
          });
          continue;
        }

        for (const event of events) {
          // Defensive: events should always have an id from Google. If one
          // ever slips through without it, the upsert would fail loudly on
          // the NOT NULL constraint; skip and log instead.
          if (!event.id) {
            console.warn("[ingest-calendar:event] missing id, skipping", {
              userId: cred.user_id,
              calendarId: cal.id,
            });
            continue;
          }

          // start/end can be { dateTime } (ISO 8601) for timed events OR
          // { date } (YYYY-MM-DD) for all-day events. For all-day we MUST
          // explicitly append T00:00:00Z — relying on Postgres to parse a
          // bare date into a timestamptz uses the SESSION TimeZone setting,
          // which is silently wrong if a future role changes it. Explicit
          // UTC midnight removes that dependency.
          const rawStart = event.start?.dateTime ?? event.start?.date ?? null;
          const rawEnd = event.end?.dateTime ?? event.end?.date ?? null;
          const startIso = event.start?.dateTime
            ? rawStart
            : (event.start?.date ? `${event.start.date}T00:00:00Z` : null);
          const endIso = event.end?.dateTime
            ? rawEnd
            : (event.end?.date ? `${event.end.date}T00:00:00Z` : null);
          if (!startIso || !endIso) {
            // Some cancelled events come back with no start/end — skip.
            // We still ingest cancelled events that have a start/end so the
            // dashboard can show "this meeting was cancelled" cleanly.
            continue;
          }
          const isAllDay = !event.start?.dateTime && !!event.start?.date;

          const attendees = Array.isArray(event.attendees) ? event.attendees : [];
          const userResponse = normalizeResponseStatus(
            attendees.find((a) => a?.self)?.responseStatus,
          );
          const externalCount = attendees.filter((a) => {
            if (!a) return false;
            if (a.self) return false;
            if (a.organizer) return false;
            if (!a.email) return false;
            if (userDomain) {
              const at = a.email.lastIndexOf("@");
              if (at >= 0) {
                const dom = a.email.slice(at + 1).toLowerCase();
                if (dom === userDomain) return false;
              }
            }
            return true;
          }).length;

          const { conferenceLink, conferenceType } = extractConferenceLink(event);

          insertRows.push({
            user_id: cred.user_id,
            google_calendar_id: cal.id,
            google_event_id: event.id,
            ical_uid: event.iCalUID ?? null,
            title: event.summary ?? "(no title)",
            description: event.description ?? null,
            start_at: startIso,
            end_at: endIso,
            all_day: isAllDay,
            location: event.location ?? null,
            conference_link: conferenceLink,
            conference_type: conferenceType,
            organizer_email: event.organizer?.email ?? null,
            organizer_self: !!event.organizer?.self,
            attendees: attendees,
            attendee_count: attendees.length,
            external_attendee_count: externalCount,
            user_response_status: userResponse,
            event_status: normalizeEventStatus(event.status),
            raw: event,
            received_at: Date.now(),
          });
        }
      }

      // --- 5. Bulk upsert (refresh on conflict) -------------------------
      // ignoreDuplicates=false → on UNIQUE(user_id, google_event_id)
      // collision we REFRESH all the columns so reschedules / accept-flips
      // / title edits show up in the dashboard on the next firing.
      let upserted = 0;
      if (insertRows.length > 0) {
        const { error: insertErr } = await supabase
          .from("calendar_events")
          .upsert(insertRows, {
            onConflict: "user_id,google_event_id",
            ignoreDuplicates: false,
          });
        if (insertErr) {
          // Treat as transient — don't disconnect. Next firing retries the
          // same window (idempotent via the UNIQUE constraint).
          console.error("[ingest-calendar:insert] upsert failed", {
            userId: cred.user_id,
            rows: insertRows.length,
            message: insertErr.message,
          });
          continue;
        }
        upserted = insertRows.length;
      }

      // --- 6. Touch updated_at as a last-poll marker --------------------
      // No separate last_polled_at column for v0 — updated_at serves as the
      // "we successfully polled" marker. Stamp it to (firing start - 60s)
      // for consistency with the slack/notion overlap convention even
      // though the calendar route doesn't use a since-watermark.
      const pollMarkerIso = new Date(startedAt - 60_000).toISOString();
      const { error: touchErr } = await supabase
        .from("calendar_credentials")
        .update({ updated_at: pollMarkerIso })
        .eq("user_id", cred.user_id)
        .eq("refresh_token", cred.refresh_token);
      if (touchErr) {
        console.warn("[ingest-calendar:touch] updated_at touch failed", {
          userId: cred.user_id,
          message: touchErr.message,
        });
      }

      usersProcessed += 1;
      eventsUpserted += upserted;
      console.log("[ingest-calendar:user] ok", {
        userId: cred.user_id,
        calendars: calendars.length,
        eventsCollected: insertRows.length,
        upserted,
        timeMinIso,
        timeMaxIso,
      });
    } catch (err) {
      if (err instanceof GoogleCalendarAuthError) {
        // Token revoked / scope removed / unauthorized. Flip the
        // credentials row to disconnected so the next cron skips it.
        // Reconnect flow (out of scope here) re-OAuths and flips back.
        const { error: disconnectErr } = await supabase
          .from("calendar_credentials")
          .update({
            status: "disconnected",
            disconnected_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", cred.user_id);
        if (disconnectErr) {
          console.error("[ingest-calendar:disconnect] flip failed", {
            userId: cred.user_id,
            message: disconnectErr.message,
          });
        } else {
          usersDisconnected += 1;
          console.warn("[ingest-calendar:disconnect] user disconnected", {
            userId: cred.user_id,
            reason: err.message,
          });
        }
        continue;
      }

      // Other errors — log, isolate to this user, continue.
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[ingest-calendar:user] transient error, will retry", {
        userId: cred.user_id,
        message: detail,
      });
      continue;
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log("[ingest-calendar:done]", {
    usersProcessed,
    eventsUpserted,
    usersDisconnected,
    usersSkippedNoCreds,
    elapsedMs,
  });

  return NextResponse.json({
    ok: true,
    usersProcessed,
    eventsUpserted,
    usersDisconnected,
    usersSkippedNoCreds,
    elapsedMs,
  });
}
