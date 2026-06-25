"use client";

// Dashboard "cadence" section. Renders the top-5 contacts whose cadence has
// broken (last_seen_at older than the user's typical cadence). Per Tab 2
// 09:35 UTC architectural lock: this section sits ABOVE CalendarTodayView AND
// ONLY renders when non-empty — Tab 1 D5 forbids empty-state placeholders
// cluttering the dashboard. Loading state is silent (returns null) for the
// same reason: a skeleton above Today's Calendar would be a visual jolt for
// users with no cadence flags.
//
// Redesign (08:30 + 08:55 UTC 2026-06-18): uses the shared DashboardRow
// pattern. Lock 3: cadence rows open `/contacts/[id]` in the SAME tab (this
// is a Wingman-internal navigation, not external), so external={false}.

import {
  useContacts,
  type FeedbackSourceTable,
} from "@/lib/supabase/hooks";
import {
  DashboardRow,
  DashboardRowList,
  DashboardSection,
  DashboardSectionHeader,
  SECTION_ACCENTS,
  dotForCadenceDays,
  formatCadenceDays,
} from "./_primitives";

type CadenceFlagsViewProps = {
  // Commit 12: parent (DashboardView) passes this so each cadence row can
  // open the feedback popover anchored to itself. Curried per row with
  // sourceTable='contacts' + sourceId=contact.id.
  onCommentClick?: (
    sourceTable: FeedbackSourceTable,
    sourceId: string,
    dashboardSection: string,
    anchorEl: HTMLElement,
    title: string,
  ) => void;
};

export function CadenceFlagsView({ onCommentClick }: CadenceFlagsViewProps = {}) {
  const { data: contacts, isLoading } = useContacts("cadence-break");

  // Silent during the loading flicker; switch to a positive empty state when
  // the query lands with zero rows (Mega-commit A #11).
  if (isLoading) return null;
  if (!contacts || contacts.length === 0) {
    return (
      <DashboardSection accentColor={SECTION_ACCENTS.cadence}>
        <DashboardSectionHeader title="cadence" />
        <p className="px-2 py-1 font-serif text-xs italic text-gray-500">
          All caught up — no relationships gone cold this week.
        </p>
      </DashboardSection>
    );
  }

  const top = contacts.slice(0, 5);
  const anyOverdue = top.some((c) => (c.cadence_break_days ?? 0) >= 28);
  return (
    <DashboardSection accentColor={SECTION_ACCENTS.cadence}>
      <DashboardSectionHeader
        title="cadence"
        count={`${top.length} cold`}
        chipColor={anyOverdue ? "red" : "amber"}
      />
      <DashboardRowList>
        {top.map((c) => (
          <DashboardRow
            key={c.id}
            dot={dotForCadenceDays(c.cadence_break_days)}
            dotLabel={
              c.cadence_break_days == null
                ? "cadence unknown"
                : `${c.cadence_break_days} days since contact`
            }
            time={formatCadenceDays(c.cadence_break_days)}
            title={c.display_name}
            badge="cadence"
            hint="reach out"
            href={`/contacts/${c.id}`}
            external={false}
            sourceTable="contacts"
            sourceId={c.id}
            onCommentClick={
              onCommentClick
                ? (anchorEl, title) =>
                    onCommentClick(
                      "contacts",
                      c.id,
                      "cadence",
                      anchorEl,
                      title,
                    )
                : undefined
            }
          />
        ))}
      </DashboardRowList>
    </DashboardSection>
  );
}
