"use client";

// Dashboard "decisions" section. Mirrors CadenceFlagsView's shape (silent
// when empty, no skeleton). Per Tab 2 09:35 UTC architectural lock: sits
// ABOVE CalendarTodayView, BELOW CadenceFlagsView. The decisions route
// filters status='postmortem_due' on the server, so by the time rows arrive
// here, they're all overdue for review.
//
// Redesign (08:30 + 08:55 UTC 2026-06-18): uses the shared DashboardRow
// pattern. Lock 3: decision rows open `/decisions/[id]` in the SAME tab
// (Wingman-internal navigation), so external={false}. Time column uses
// postmortem_due_at (the ±N days countdown) — confirmed against
// DecisionRow.postmortem_due_at in src/lib/supabase/hooks.ts.

import { useDecisions } from "@/lib/supabase/hooks";
import {
  DashboardRow,
  DashboardRowList,
  DashboardSection,
  DashboardSectionHeader,
  dotForPostmortemDue,
  formatPostmortemDays,
} from "./_primitives";

export function DecisionsPostmortemDueView() {
  const { data: decisions, isLoading } = useDecisions("postmortem_due");

  if (isLoading || !decisions || decisions.length === 0) return null;

  return (
    <DashboardSection>
      <DashboardSectionHeader
        title="decisions"
        count={`${decisions.length} due`}
      />
      <DashboardRowList>
        {decisions.map((d) => {
          const dot = dotForPostmortemDue(d.postmortem_due_at);
          const dotLabel =
            dot === "red"
              ? "postmortem overdue"
              : dot === "amber"
                ? "postmortem due soon"
                : "postmortem upcoming";
          return (
            <DashboardRow
              key={d.id}
              dot={dot}
              dotLabel={dotLabel}
              time={formatPostmortemDays(d.postmortem_due_at)}
              title={d.title}
              badge="postmortem"
              hint="write"
              href={`/decisions/${d.id}`}
              external={false}
            />
          );
        })}
      </DashboardRowList>
    </DashboardSection>
  );
}
