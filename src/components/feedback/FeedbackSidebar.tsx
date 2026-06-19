"use client";

// Slide-in panel listing all review notes. Opened from the floating
// FeedbackButton's "View all notes" link OR from Cmd+Shift+R (handled by
// DashboardView). Filter pills: All / Open / Addressed / Dismissed
// (default Open — most actionable view first). Sidebar UX is distinct
// from the popover: outside-click does NOT close the sidebar (only X or
// Escape), so the founder can read a note and still interact with the
// dashboard underneath without dismissing the panel.

import { useEffect, useRef, useState } from "react";
import {
  useFeedbackNotes,
  useUpdateFeedback,
  useDeleteFeedback,
  type FeedbackFilter,
  type FeedbackNote,
} from "@/lib/supabase/hooks";
import { formatRelativeAge } from "@/app/dashboard/_primitives";

type FeedbackSidebarProps = {
  isOpen: boolean;
  onClose: () => void;
};

const FILTERS: { value: FeedbackFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "all", label: "All" },
  { value: "addressed", label: "Addressed" },
  { value: "dismissed", label: "Dismissed" },
];

export function FeedbackSidebar({ isOpen, onClose }: FeedbackSidebarProps) {
  const [filter, setFilter] = useState<FeedbackFilter>("open");
  const { data, isLoading, mutate } = useFeedbackNotes(isOpen ? filter : null);
  const updateFeedback = useUpdateFeedback();
  const deleteFeedback = useDeleteFeedback();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  // Escape closes. Use stopPropagation (NOT preventDefault) so a popover
  // sitting on top of this sidebar can decide which one closes via its
  // own handler — listeners fire in registration order, and the
  // most-recently-opened surface (the popover) gets first crack at the
  // event, then stops propagation so only it closes. Outside-click does
  // NOT close — deliberate UX so the founder can read a note and still
  // interact with the dashboard underneath.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  // When the sidebar opens, move focus to the close button after the
  // slide animation finishes (200ms transition). Without this, focus
  // remains on whatever triggered the open (often a "+", which is now
  // visually behind the slide-in panel) and keyboard users can't tell
  // anything happened.
  useEffect(() => {
    if (!isOpen) return;
    const id = window.setTimeout(() => {
      closeButtonRef.current?.focus();
    }, 200);
    return () => window.clearTimeout(id);
  }, [isOpen]);

  // Spread the `inert` attribute on the panel when closed. `inert`
  // removes children from tab order AND the aria tree (replaces the
  // previous aria-hidden + translate-x-full combo, which left children
  // tabbable — an a11y violation). React's HTMLAttributes type added
  // `inert` recently but older @types/react may not have it; we use a
  // typed-object spread to avoid a TS error on stale type packages.
  const inertProps = (isOpen ? {} : { inert: "" }) as Record<string, string>;

  return (
    <aside
      role="dialog"
      aria-modal="true"
      aria-label="Review notes"
      {...inertProps}
      className={`fixed right-0 top-0 z-50 flex h-full w-[380px] flex-col border-l border-gray-200 bg-white shadow-2xl transition-transform duration-200 ${
        isOpen ? "translate-x-0" : "translate-x-full"
      }`}
    >
      <header className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-900">Review notes</h2>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label="Close sidebar"
          className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>

      <div className="flex gap-1 border-b border-gray-200 px-3 py-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
              filter === f.value
                ? "border-black bg-black text-white"
                : "border-gray-300 bg-white text-gray-600 hover:border-gray-500"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && !data ? (
          <p className="px-4 py-6 text-xs text-gray-500">Loading…</p>
        ) : !data || data.length === 0 ? (
          <p className="px-4 py-6 text-xs text-gray-500">
            No notes in this filter.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {data.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                onUpdate={async (patch) => {
                  await updateFeedback(note.id, patch);
                  await mutate();
                }}
                onDelete={async () => {
                  await deleteFeedback(note.id);
                  await mutate();
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

type NoteRowProps = {
  note: FeedbackNote;
  onUpdate: (patch: {
    title?: string;
    body?: string | null;
    status?: FeedbackNote["status"];
  }) => Promise<void>;
  onDelete: () => Promise<void>;
};

function NoteRow({ note, onUpdate, onDelete }: NoteRowProps) {
  const isOpen = note.status === "open";
  const [expanded, setExpanded] = useState<boolean>(false);
  // Source label: prefer source_table/source_id pair; else dashboard_section
  // "floating" → "floating"; else "dashboard".
  let sourceLabel: string;
  if (note.source_table && note.source_id) {
    sourceLabel = `${note.source_table} / ${note.source_id}`;
  } else if (note.dashboard_section === "floating") {
    sourceLabel = "floating";
  } else {
    sourceLabel = "dashboard";
  }
  const createdMs = new Date(note.created_at).getTime();
  // Show-more threshold: 200 chars OR more than ~3 lines (rough heuristic
  // via newline count). When collapsed, render line-clamp-3 + toggle;
  // when expanded, render whitespace-pre-wrap so multiline notes read
  // naturally.
  const body = note.body ?? "";
  const isLong = body.length > 200 || body.split("\n").length > 3;

  const handleDelete = () => {
    if (typeof window === "undefined") return;
    if (window.confirm("Delete this note?")) {
      void onDelete();
    }
  };

  return (
    <li className="px-4 py-3">
      <p className="text-sm font-semibold text-gray-900">{note.title}</p>
      {note.body && (
        <>
          {isLong && !expanded ? (
            <>
              <p className="mt-0.5 line-clamp-3 text-xs text-gray-600">
                {note.body}
              </p>
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="mt-1 text-[11px] text-gray-500 hover:text-gray-900"
              >
                Show more
              </button>
            </>
          ) : (
            <>
              <p className="mt-0.5 whitespace-pre-wrap text-xs text-gray-600">
                {note.body}
              </p>
              {isLong && (
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  className="mt-1 text-[11px] text-gray-500 hover:text-gray-900"
                >
                  Show less
                </button>
              )}
            </>
          )}
        </>
      )}
      <p className="mt-1 truncate font-mono text-[10px] lowercase text-gray-400">
        {sourceLabel} · {formatRelativeAge(createdMs)}
      </p>
      <div className="mt-2 flex flex-wrap gap-1">
        {isOpen ? (
          <>
            <button
              type="button"
              onClick={() => onUpdate({ status: "addressed" })}
              className="rounded px-2 py-1 text-xs font-medium text-green-700 hover:bg-gray-100"
            >
              Mark addressed
            </button>
            <button
              type="button"
              onClick={() => onUpdate({ status: "dismissed" })}
              className="rounded px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
            >
              Dismiss
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => onUpdate({ status: "open" })}
            className="rounded px-2 py-1 text-xs font-medium text-blue-700 hover:bg-gray-100"
          >
            Reopen
          </button>
        )}
        <button
          type="button"
          onClick={handleDelete}
          className="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
        >
          Delete
        </button>
      </div>
    </li>
  );
}
