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

import {
  useDecisions,
  type FeedbackSourceTable,
} from "@/lib/supabase/hooks";
import Link from "next/link";
import {
  DashboardRow,
  DashboardRowList,
  DashboardSection,
  DashboardSectionHeader,
  SECTION_ACCENTS,
  dotForPostmortemDue,
  formatPostmortemDays,
} from "./_primitives";

type DecisionsPostmortemDueViewProps = {
  // Commit 12: parent forwards this so each decision row can open the
  // feedback popover. Curried with sourceTable='decisions' + sourceId=d.id.
  onCommentClick?: (
    sourceTable: FeedbackSourceTable,
    sourceId: string,
    dashboardSection: string,
    anchorEl: HTMLElement,
    title: string,
  ) => void;
};

export function DecisionsPostmortemDueView({
  onCommentClick,
}: DecisionsPostmortemDueViewProps = {}) {
  const { data: decisions, isLoading } = useDecisions("postmortem_due");

  if (isLoading) return null;
  if (!decisions || decisions.length === 0) {
    return (
      <DashboardSection accentColor={SECTION_ACCENTS.decisions}>
        <DashboardSectionHeader title="decisions" />
        <p className="px-2 py-1 font-serif text-xs italic text-gray-500">
          No decisions logged yet — capture your first one at{" "}
          <Link href="/decisions" className="underline hover:text-gray-700">
            /decisions
          </Link>
          .
        </p>
      </DashboardSection>
    );
  }

  const anyOverdue = decisions.some(
    (d) =>
      d.postmortem_due_at !== null &&
      new Date(d.postmortem_due_at).getTime() < Date.now(),
  );
  return (
    <DashboardSection accentColor={SECTION_ACCENTS.decisions}>
      <DashboardSectionHeader
        title="decisions"
        count={`${decisions.length} due`}
        chipColor={anyOverdue ? "red" : "amber"}
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
              sourceTable="decisions"
              sourceId={d.id}
              onCommentClick={
                onCommentClick
                  ? (anchorEl, title) =>
                      onCommentClick(
                        "decisions",
                        d.id,
                        "decisions",
                        anchorEl,
                        title,
                      )
                  : undefined
              }
            />
          );
        })}
      </DashboardRowList>
    </DashboardSection>
  );
}
