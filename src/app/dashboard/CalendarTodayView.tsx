"use client";

// Today's Calendar — renders at the TOP of /dashboard above email/Slack/Notion.
// Calendar = highest time-sensitivity signal for a founder per Tab 2 06:05 UTC
// spec. Today expanded by default, Tomorrow collapsible, no view past tomorrow.
// All-day events as a thin strip above timed events. Cancelled filtered at the
// query layer (event_status='confirmed').

import { useState } from "react";
import Link from "next/link";
import {
  useCalendarCredentials,
  useCalendarToday,
  type CalendarEventRow,
} from "@/lib/supabase/hooks";

// Prep-priority badge palette. 'none' renders no badge (the absence-of-badge
// state is itself the signal — no visual weight added when there's nothing
// for the founder to prep).
const PREP_BADGE: Record<NonNullable<CalendarEventRow["prep_priority"]>, string> = {
  high: "bg-red-100 text-red-800 border-red-200",
  medium: "bg-amber-100 text-amber-800 border-amber-200",
  low: "bg-gray-100 text-gray-600 border-gray-200",
  none: "",
};

export function CalendarTodayView() {
  const { data: credentials, isLoading: credsLoading } =
    useCalendarCredentials();
  // Only enable the events query when credentials are present AND active.
  // Passing `false` keeps the SWR key null so the query never fires for
  // disconnected/unconnected users — avoids the reactive-query-amplification
  // anti-pattern documented in MEMORY.md.
  const enabled = credentials?.status === "active";
  const { data: feed, isLoading: feedLoading } = useCalendarToday(enabled);
  const [tomorrowOpen, setTomorrowOpen] = useState(false);

  // Connect-banner: only render once credentials have loaded AND come back
  // null (never connected). Per Tab 1 D5, the not-connected message is held
  // back during credsLoading to avoid the flash-of-empty-state where the
  // banner pops then immediately swaps for a connected calendar.
  if (!credsLoading && !credentials) {
    return (
      <section className="max-w-4xl mx-auto mt-6 rounded-lg border border-blue-200 bg-blue-50 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-blue-900">
              Connect Google Calendar
            </p>
            <p className="mt-1 text-xs text-blue-800">
              See today&apos;s meetings + prep priorities surfaced for you
              alongside email and Slack.
            </p>
          </div>
          <Link
            href="/settings"
            className="shrink-0 rounded-md bg-blue-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-800"
          >
            Connect
          </Link>
        </div>
      </section>
    );
  }

  if (!credsLoading && credentials?.status === "disconnected") {
    return (
      <section className="max-w-4xl mx-auto mt-6 rounded-lg border border-red-200 bg-red-50 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-red-900">
              Calendar disconnected
            </p>
            <p className="mt-1 text-xs text-red-800">
              Reconnect to keep seeing today&apos;s meetings.
            </p>
          </div>
          <Link
            href="/settings"
            className="shrink-0 rounded-md bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800"
          >
            Reconnect
          </Link>
        </div>
      </section>
    );
  }

  // Loading state — thin text avoids any "Connect" banner flash before
  // credentials resolve. Per Tab 1 D5.
  if (credsLoading || feedLoading) {
    return (
      <section className="max-w-4xl mx-auto mt-6 p-4 text-sm text-gray-500">
        Loading today&apos;s calendar…
      </section>
    );
  }

  const today = feed?.today ?? [];
  const tomorrow = feed?.tomorrow ?? [];
  // Filter past meetings from today's list so the founder sees what's still
  // upcoming today. Compares end_at against now so an in-progress meeting
  // (started but not ended) still appears.
  const now = Date.now();
  const upcoming = today.filter(
    (ev) => new Date(ev.end_at).getTime() >= now,
  );
  const allDayToday = upcoming.filter((ev) => ev.all_day);
  const timedToday = upcoming.filter((ev) => !ev.all_day);

  return (
    <section className="max-w-4xl mx-auto mt-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">
          Today&apos;s Calendar
        </h2>
      </div>

      {allDayToday.length > 0 && (
        <div className="mb-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-700">
          <span className="font-medium">All day:</span>{" "}
          {allDayToday.map((ev) => ev.title).join(" · ")}
        </div>
      )}

      {timedToday.length === 0 && allDayToday.length === 0 && (
        <p className="text-sm text-gray-500">
          No more meetings today. Enjoy the space.
        </p>
      )}

      {timedToday.length > 0 && (
        <div className="space-y-1">
          {timedToday.map((ev) => (
            <EventRow key={ev.id} event={ev} />
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => setTomorrowOpen((v) => !v)}
        className="mt-4 flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900"
      >
        Tomorrow {tomorrowOpen ? "▴" : "▾"}{" "}
        {tomorrow.length > 0 ? `(${tomorrow.length})` : ""}
      </button>

      {tomorrowOpen && (
        <div className="mt-2 space-y-1">
          {tomorrow.length === 0 ? (
            <p className="text-xs text-gray-500">Nothing scheduled.</p>
          ) : (
            tomorrow.map((ev) => <EventRow key={ev.id} event={ev} />)
          )}
        </div>
      )}
    </section>
  );
}

// Single event row. Inline-expandable on click. Conference-link "Join" button
// stops propagation so opening Zoom/Meet doesn't also toggle the expand state.
function EventRow({ event }: { event: CalendarEventRow }) {
  const [expanded, setExpanded] = useState(false);
  const start = new Date(event.start_at);
  const end = new Date(event.end_at);
  const startStr = start.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const durMin = Math.round((end.getTime() - start.getTime()) / 60000);
  const durStr =
    durMin >= 60
      ? `${Math.floor(durMin / 60)}h${durMin % 60 ? ` ${durMin % 60}m` : ""}`
      : `${durMin}m`;
  const prepClass =
    event.prep_priority && event.prep_priority !== "none"
      ? PREP_BADGE[event.prep_priority]
      : "";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setExpanded((v) => !v)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setExpanded((v) => !v);
        }
      }}
      className="cursor-pointer rounded-md border border-gray-100 bg-white hover:border-gray-300"
    >
      <div className="flex items-center gap-3 px-3 py-2">
        <span className="w-12 shrink-0 font-mono text-xs text-gray-600">
          {startStr}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-gray-900">
              {event.title}
            </span>
            {event.prep_priority && event.prep_priority !== "none" && (
              <span
                className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase ${prepClass}`}
              >
                {event.prep_priority} prep
              </span>
            )}
          </div>
        </div>
        <span className="shrink-0 text-xs text-gray-500">{durStr}</span>
        {event.attendee_count != null && event.attendee_count > 1 && (
          <span className="shrink-0 text-xs text-gray-500">
            {event.attendee_count}p
          </span>
        )}
        {event.conference_link && (
          <a
            href={event.conference_link}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 text-xs font-medium text-blue-700 hover:underline"
          >
            Join
          </a>
        )}
      </div>
      {expanded && (
        <div className="space-y-1 border-t border-gray-100 px-3 py-2 text-xs text-gray-700">
          {event.prep_notes && (
            <p>
              <strong>Prep:</strong> {event.prep_notes}
            </p>
          )}
          {event.location && (
            <p>
              <strong>Location:</strong> {event.location}
            </p>
          )}
          {event.attendees && event.attendees.length > 0 && (
            <p>
              <strong>Attendees:</strong>{" "}
              {event.attendees
                .map((a) => a.displayName ?? a.email)
                .filter(Boolean)
                .join(", ")}
            </p>
          )}
          {event.conference_link && (
            <p>
              <strong>Link:</strong>{" "}
              <a
                href={event.conference_link}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-blue-700 hover:underline"
              >
                {event.conference_link}
              </a>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
