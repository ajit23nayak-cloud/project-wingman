"use client";

// Small orange dot next to a DashboardRow when it has one or more OPEN
// feedback notes. Visible only when the row has unresolved review notes —
// addressed/dismissed notes don't surface. Rendered inside the badge area
// of DashboardRow (after the badge, before the hint).
//
// Per Commit 12 spec: 6px circle, bg-[#EF9F27] (matching the spec orange
// from MH_UI_SPEC.md), `title` attribute carries the "N comment(s)"
// tooltip. When no open notes exist, renders nothing.

import {
  useFeedbackNotesForRow,
  type FeedbackSourceTable,
} from "@/lib/supabase/hooks";

type RowCommentIndicatorProps = {
  sourceTable: FeedbackSourceTable;
  sourceId: string;
};

export function RowCommentIndicator({
  sourceTable,
  sourceId,
}: RowCommentIndicatorProps) {
  const { data } = useFeedbackNotesForRow(sourceTable, sourceId);
  // Only surface OPEN notes. Addressed/dismissed are still in the row's
  // history (visible from the sidebar) but don't deserve a per-row dot.
  const openNotes = (data ?? []).filter((n) => n.status === "open");
  if (openNotes.length === 0) return null;
  const label = `${openNotes.length} comment${openNotes.length === 1 ? "" : "s"}`;
  return (
    <span
      className="ml-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[#EF9F27]"
      title={label}
      aria-label={label}
    />
  );
}
