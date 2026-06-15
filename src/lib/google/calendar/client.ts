// Google Calendar Web API wrappers. Thin fetch-based client (no googleapis
// SDK) because:
//   (a) one fewer dep + smaller cold-start,
//   (b) we only use two endpoints (calendarList + events.list),
//   (c) error handling needs a typed GoogleCalendarAuthError so the ingest
//       cron can mark calendar_credentials.status='disconnected' on 401
//       (revoked / expired-without-refresh) instead of inspecting random
//       Error subclasses.
//
// Mirrors the SlackAuthError / GmailAuthError pattern.
//
// API base: https://www.googleapis.com/calendar/v3
// Auth header: `Authorization: Bearer ${accessToken}` (OAuth2 access token).
// Errors:
//   - HTTP 401 → token expired/revoked → throw GoogleCalendarAuthError(401).
//   - Other 4xx/5xx → throw generic Error(`google_calendar_api_failed:...`).

import "server-only";

// Typed sentinel for Google Calendar auth failures. The ingest cron catches
// this and marks calendar_credentials.status='disconnected'; UI surfaces a
// "Reconnect Google Calendar" CTA in /settings.
export class GoogleCalendarAuthError extends Error {
  constructor(public readonly status: number) {
    super(`google_calendar_auth_failed:${status}`);
    this.name = "GoogleCalendarAuthError";
  }
}

// Subset of Google's event shape we actually consume. The ingest cron does
// the typed pluck off this; the raw JSON gets stored as-is in
// calendar_events.raw for debugging / v1 widening (additional fields like
// recurrence, extendedProperties, etc.).
export type GoogleCalendarEvent = {
  id: string;
  iCalUID?: string;
  summary?: string;
  description?: string;
  status?: string; // 'confirmed' | 'tentative' | 'cancelled'
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  location?: string;
  hangoutLink?: string;
  conferenceData?: unknown;
  organizer?: { email?: string; self?: boolean };
  attendees?: Array<{
    email?: string;
    self?: boolean;
    organizer?: boolean;
    responseStatus?: string;
    displayName?: string;
  }>;
  [k: string]: unknown;
};

// Single point that turns non-2xx HTTP into the right typed error. Keep the
// surface narrow so callers always know which exception to expect.
async function googleFetch(
  url: string,
  accessToken: string,
): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401) throw new GoogleCalendarAuthError(401);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // Strip query string from the URL in the error message so OAuth tokens
    // (which can land in query for pageToken refreshes) don't leak into logs.
    throw new Error(
      `google_calendar_api_failed:${url.split("?")[0]}:${res.status}:${detail.slice(0, 200)}`,
    );
  }
  return res.json();
}

type CalendarListEntry = {
  id?: string;
  summary?: string;
  primary?: boolean;
  selected?: boolean;
  accessRole?: string;
};

type CalendarListResponse = {
  items?: CalendarListEntry[];
  nextPageToken?: string;
};

// listSelectedCalendars: GET /users/me/calendarList. Returns only calendars
// the user has ticked as "show" in Google Calendar (item.selected === true) —
// secondary/holiday calendars they unchecked shouldn't drive prep nudges.
//
// Paginates via nextPageToken for safety though a v0 cohort user will return
// 5–30 calendars and never hit the 250 cap.
export async function listSelectedCalendars(
  accessToken: string,
): Promise<{ id: string; summary: string; primary: boolean }[]> {
  const out: { id: string; summary: string; primary: boolean }[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ maxResults: "250" });
    if (pageToken) params.set("pageToken", pageToken);
    const json = (await googleFetch(
      `https://www.googleapis.com/calendar/v3/users/me/calendarList?${params.toString()}`,
      accessToken,
    )) as CalendarListResponse;

    for (const item of json.items ?? []) {
      if (!item.id) continue;
      // Filter to selected=true client-side per spec scope lock — Google
      // doesn't expose a server-side filter for this field.
      if (item.selected !== true) continue;
      out.push({
        id: item.id,
        summary: item.summary ?? "",
        primary: item.primary === true,
      });
    }
    pageToken = json.nextPageToken || undefined;
  } while (pageToken);
  return out;
}

type EventsListResponse = {
  items?: GoogleCalendarEvent[];
  nextPageToken?: string;
};

// listEvents: GET /calendars/{calendarId}/events for the [timeMinIso, timeMaxIso]
// window. singleEvents=true expands recurring series into instances so each
// occurrence flows through the prep classifier independently. showDeleted=true
// includes cancelled events (status='cancelled') so the ingest path can mark
// previously-stored events as cancelled rather than orphan them.
//
// Paginates until exhausted; the typical 1-day-past + 14-day-future window
// won't exceed the 2500 cap but we page to be safe.
//
// calendarId is URL-encoded — Google calendar IDs frequently contain '@' and
// other characters that would otherwise corrupt the path.
export async function listEvents(
  accessToken: string,
  calendarId: string,
  timeMinIso: string,
  timeMaxIso: string,
): Promise<GoogleCalendarEvent[]> {
  const out: GoogleCalendarEvent[] = [];
  let pageToken: string | undefined;
  const encodedId = encodeURIComponent(calendarId);
  do {
    const params = new URLSearchParams({
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
      singleEvents: "true",
      showDeleted: "true",
      maxResults: "2500",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const json = (await googleFetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodedId}/events?${params.toString()}`,
      accessToken,
    )) as EventsListResponse;

    for (const item of json.items ?? []) {
      if (!item.id) continue;
      out.push(item);
    }
    pageToken = json.nextPageToken || undefined;
  } while (pageToken);
  return out;
}
