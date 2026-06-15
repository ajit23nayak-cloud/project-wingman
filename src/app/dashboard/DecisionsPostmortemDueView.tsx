"use client";

// Dashboard "Decisions due for postmortem" section. Mirrors CadenceFlagsView's
// shape (silent when empty, no skeleton). Per Tab 2 09:35 UTC architectural
// lock: sits ABOVE CalendarTodayView, BELOW CadenceFlagsView. The decisions
// route filters status='postmortem_due' on the server, so by the time rows
// arrive here, they're all overdue for review.

import Link from "next/link";
import { useDecisions } from "@/lib/supabase/hooks";

export function DecisionsPostmortemDueView() {
  const { data: decisions, isLoading } = useDecisions("postmortem_due");

  if (isLoading || !decisions || decisions.length === 0) return null;

  return (
    <section className="max-w-4xl mx-auto mt-6">
      <h2 className="text-base font-semibold text-gray-900 mb-2">
        Decisions due for postmortem
      </h2>
      <div className="space-y-1">
        {decisions.map((d) => (
          <Link
            key={d.id}
            href={`/decisions/${d.id}`}
            className="flex items-center justify-between rounded-md border border-purple-100 bg-purple-50 px-3 py-2 hover:border-purple-300"
          >
            <span className="text-sm text-purple-900">{d.title}</span>
            <span className="text-xs text-purple-700">
              decided {formatRelativeDate(d.decision_made_at)}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function formatRelativeDate(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}
