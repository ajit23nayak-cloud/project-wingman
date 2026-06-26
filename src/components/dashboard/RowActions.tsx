"use client";

// Hover-revealed inline row actions (Mega-commit B 13a #1). Renders inside
// DashboardRow when the row's `actions` prop is set. v0 ships ONLY the
// snooze action — archive/mark-urgent/etc. are deferred per pushback flag
// (memory rule: don't add features beyond what the task requires).
//
// Pattern mirrors the existing 💬 affordance: opacity-0 by default,
// group-hover:opacity-100 to show. Each button is a 16px icon. The snooze
// button manages its own popover (anchored to itself).

import { useRef, useState } from "react";
import { SnoozeIcon } from "@/components/icons/RowActionIcons";
import { SnoozePopover } from "./SnoozePopover";

export type RowAction =
  | {
      kind: "snooze";
      onPickSnoozedUntil: (snoozedUntil: Date) => void;
    };

export type RowActionsProps = {
  actions: RowAction[];
};

export function RowActions({ actions }: RowActionsProps) {
  const snoozeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [snoozeOpen, setSnoozeOpen] = useState(false);

  const handleSnoozeClick = (
    e: React.MouseEvent<HTMLButtonElement>,
    onPick: (d: Date) => void,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    void onPick; // captured below via the matching action object
    setSnoozeOpen((o) => !o);
  };

  // Find the snooze action callback once (v0 only supports one snooze action
  // per row; multiple kinds in future iterations).
  const snoozeAction = actions.find((a) => a.kind === "snooze");

  return (
    <span className="ml-1 flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
      {snoozeAction && (
        <>
          <button
            ref={snoozeButtonRef}
            type="button"
            aria-label="Snooze row"
            title="Snooze"
            onClick={(e) =>
              handleSnoozeClick(e, snoozeAction.onPickSnoozedUntil)
            }
            className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
          >
            <SnoozeIcon className="h-4 w-4" />
          </button>
          <SnoozePopover
            isOpen={snoozeOpen}
            onClose={() => setSnoozeOpen(false)}
            anchorEl={snoozeButtonRef.current}
            onPick={(d) => {
              snoozeAction.onPickSnoozedUntil(d);
              setSnoozeOpen(false);
            }}
          />
        </>
      )}
    </span>
  );
}
