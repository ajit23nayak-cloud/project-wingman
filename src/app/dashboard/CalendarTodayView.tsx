"use client";

// Today's Calendar — renders near the top of /dashboard above email/Slack/Notion.
// Calendar = highest time-sensitivity signal for a founder per Tab 2 06:05 UTC
// spec. Today expanded by default, Tomorrow collapsible, no view past tomorrow.
// All-day events as a thin strip above timed events. Cancelled filtered at the
// query layer (event_status='confirmed').
//
// Dashboard redesign (08:30 + 08:55 UTC 2026-06-18): active rendering uses the
// shared DashboardSection / DashboardRow primitives. Connect/Disconnected/
// Loading banners are unchanged (not row-pattern surfaces). Event rows
// preserve inline-expansion (Lock 2 spirit — expansion is the existing UX
// contract). Lock 3 of 08:55: conference_link is exposed as a "join meeting ↗"
// link INSIDE the expanded view (clean collapsed row); the row's primary click
// toggles expand.

import { useState } from "react";
import Link from "next/link";
import {
  useCalendarCredentials,
  useCalendarToday,
  type CalendarEventRow,
  type FeedbackSourceTable,
} from "@/lib/supabase/hooks";
import {
  DashboardRow,
  DashboardRowList,
  DashboardSection,
  DashboardSectionHeader,
  SECTION_ACCENTS,
  dotForPrepPriority,
  formatClock24,
} from "./_primitives";

type CalendarTodayViewProps = {
  // Commit 12: parent forwards this so each event row can open the feedback
  // popover. Curried with sourceTable='calendar_events' + sourceId=ev.id.
  onCommentClick?: (
    sourceTable: FeedbackSourceTable,
    sourceId: string,
    dashboardSection: string,
    anchorEl: HTMLElement,
    title: string,
  ) => void;
};

export function CalendarTodayView({
  onCommentClick,
}: CalendarTodayViewProps = {}) {
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
    <DashboardSection accentColor={SECTION_ACCENTS.calendar}>
      <DashboardSectionHeader
        title="calendar"
        count={`${timedToday.length} today`}
        chipColor="grey"
      />
      {allDayToday.length > 0 && (
        <div className="mx-2 mb-1 rounded border-[0.5px] border-gray-200 bg-gray-50 px-2 py-1 text-[11px] text-gray-600">
          <span className="font-mono lowercase">all day:</span>{" "}
          {allDayToday.map((ev) => ev.title).join(" · ")}
        </div>
      )}
      {timedToday.length === 0 && allDayToday.length === 0 && (
        <p className="px-2 py-1 font-serif text-xs italic text-gray-500">
          No more meetings today. Enjoy the space.
        </p>
      )}
      {timedToday.length > 0 && (
        <DashboardRowList>
          {timedToday.map((ev) => (
            <EventRow
              key={ev.id}
              event={ev}
              onCommentClick={onCommentClick}
            />
          ))}
        </DashboardRowList>
      )}
      <button
        type="button"
        onClick={() => setTomorrowOpen((v) => !v)}
        className="ml-2 mt-2 font-mono text-[11px] lowercase text-gray-500 hover:text-gray-900"
      >
        tomorrow {tomorrowOpen ? "▴" : "▾"}
        {tomorrow.length > 0 ? ` (${tomorrow.length})` : ""}
      </button>
      {tomorrowOpen && (
        <div className="mt-1">
          {tomorrow.length === 0 ? (
            <p className="px-2 text-[11px] text-gray-500">Nothing scheduled.</p>
          ) : (
            <DashboardRowList>
              {tomorrow.map((ev) => (
                <EventRow
                  key={ev.id}
                  event={ev}
                  onCommentClick={onCommentClick}
                />
              ))}
            </DashboardRowList>
          )}
        </div>
      )}
    </DashboardSection>
  );
}

// Single event row. Inline-expandable on click — preserves the existing
// expansion UX (prep notes / location / attendees / join link). Lock 3 of
// 08:55 routes conference_link into the expanded "join meeting ↗" link; the
// collapsed row stays clean.
type EventRowProps = {
  event: CalendarEventRow;
  onCommentClick?: CalendarTodayViewProps["onCommentClick"];
};

function EventRow({ event, onCommentClick }: EventRowProps) {
  const [expanded, setExpanded] = useState(false);
  // start_at is an ISO string from supabase — wrap in Date for the epoch-ms
  // input formatClock24 expects.
  const startMs = new Date(event.start_at).getTime();

  return (
    <div>
      <DashboardRow
        dot={dotForPrepPriority(event.prep_priority)}
        dotLabel={`prep priority: ${event.prep_priority ?? "none"}`}
        time={formatClock24(startMs)}
        title={event.title}
        badge="calendar"
        hint={
          expanded ? "collapse" : event.conference_link ? "join" : "open"
        }
        onClick={() => setExpanded((v) => !v)}
        sourceTable="calendar_events"
        sourceId={event.id}
        onCommentClick={
          onCommentClick
            ? (anchorEl, title) =>
                onCommentClick(
                  "calendar_events",
                  event.id,
                  "calendar",
                  anchorEl,
                  title,
                )
            : undefined
        }
      />
      {expanded && (
        <div className="border-t-[0.5px] border-gray-100 bg-gray-50/50 px-3 py-2 text-[11px] text-gray-700 space-y-1">
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
              <a
                href={event.conference_link}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono lowercase text-blue-700 hover:underline"
              >
                join meeting ↗
              </a>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
