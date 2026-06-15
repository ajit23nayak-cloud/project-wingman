"use client";

// Dashboard "People to reach out to" section. Renders the top-5 contacts whose
// cadence has broken (last_seen_at older than the user's typical cadence). Per
// Tab 2 09:35 UTC architectural lock: this section sits ABOVE CalendarTodayView
// AND ONLY renders when non-empty — Tab 1 D5 forbids empty-state placeholders
// cluttering the dashboard. Loading state is silent (returns null) for the same
// reason: a skeleton above Today's Calendar would be a visual jolt for users
// with no cadence flags.

import Link from "next/link";
import { useContacts } from "@/lib/supabase/hooks";

export function CadenceFlagsView() {
  const { data: contacts, isLoading } = useContacts("cadence-break");

  // Silent until we have something to show. Loading + empty both → null so the
  // dashboard's section order (cadence → decisions → calendar → email) stays
  // tight when this section is irrelevant.
  if (isLoading || !contacts || contacts.length === 0) return null;

  const top = contacts.slice(0, 5);
  return (
    <section className="max-w-4xl mx-auto mt-6">
      <h2 className="text-base font-semibold text-gray-900 mb-2">
        People to reach out to
      </h2>
      <div className="space-y-1">
        {top.map((c) => (
          <Link
            key={c.id}
            href={`/contacts/${c.id}`}
            className="flex items-center justify-between rounded-md border border-amber-100 bg-amber-50 px-3 py-2 hover:border-amber-300"
          >
            <span className="text-sm text-amber-900">{c.display_name}</span>
            <span className="text-xs text-amber-700">
              {weeksAgo(c.cadence_break_days)} weeks
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

// Format cadence-break days as integer weeks. v0 simplification — under 7 days
// returns "0", which would only render if the API returned a row with sub-week
// cadence break (shouldn't happen, defensive only).
function weeksAgo(days: number | null): string {
  if (!days) return "0";
  return Math.floor(days / 7).toString();
}
