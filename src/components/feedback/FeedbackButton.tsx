"use client";

// Floating "+" entry point for in-dashboard feedback. Pinned to the
// bottom-right of /dashboard (z-40 so it floats above row content but
// below modal overlays at z-50). Clicking opens a FeedbackPopover with
// no source row attached — freeform from-the-floating-button case.
//
// Agent C wires this into DashboardView and supplies onOpenSidebar to
// switch from popover → full sidebar of all notes.

import { useRef, useState } from "react";
import { FeedbackPopover } from "./FeedbackPopover";

export type FeedbackButtonProps = {
  // Wired by Agent C to open FeedbackSidebar.
  onOpenSidebar: () => void;
};

export function FeedbackButton({ onOpenSidebar }: FeedbackButtonProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState<boolean>(false);

  return (
    <>
      <div className="group fixed bottom-6 right-6 z-40">
        {/* CSS-only tooltip — appears on hover when popover is closed.
            Hidden once the popover opens so it doesn't double up. */}
        {!open && (
          <span className="pointer-events-none absolute bottom-full right-0 mb-2 hidden whitespace-nowrap rounded bg-gray-900 px-2 py-1 font-mono text-[11px] lowercase text-white group-hover:block">
            Add review note
          </span>
        )}
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label="Add review note"
          title="Add review note"
          className="flex h-12 w-12 items-center justify-center rounded-full bg-gray-900 text-white shadow-lg transition-colors hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-2"
        >
          {/* Inline SVG plus — matches the no-icon-library convention
              of the dashboard surface (DashboardView's SettingsIcon). */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      <FeedbackPopover
        isOpen={open}
        onClose={() => setOpen(false)}
        anchorEl={buttonRef.current}
        initialTitle=""
        sourceTable={null}
        sourceId={null}
        dashboardSection="floating"
        onViewAll={onOpenSidebar}
      />
    </>
  );
}
