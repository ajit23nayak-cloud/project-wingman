"use client";

// Reusable feedback-note popover. Two callers in Commit 12:
//   1. FeedbackButton (floating "+") — opens with empty title, no source,
//      dashboard_section="floating", and a "View all notes" link wired to
//      open the sidebar.
//   2. DashboardRow hover indicator (wired by Agent C) — opens with the
//      row's title pre-filled and the row's source_table/source_id set so
//      the note is tagged to the underlying record.
//
// Visual language matches Commit 11's row primitives: 0.5px gray-200
// borders, gray-50 backgrounds, small mono labels. No icon library —
// inline SVG and CSS-only hover affordances.
//
// Positioning: fixed overlay (so it survives the parent's overflow
// clipping). When anchorEl is supplied we place the popover to the LEFT
// of the anchor (vertically aligned with the anchor's top), since the
// FeedbackButton hugs the right viewport edge. If left-edge would clip,
// fall back to right-of-anchor; if both clip, fall back to a fixed
// top-right corner near the FeedbackButton.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  useCreateFeedback,
  type FeedbackSourceTable,
} from "@/lib/supabase/hooks";

const POPOVER_MAX_WIDTH = 320;
const POPOVER_ESTIMATED_HEIGHT = 220;
const ANCHOR_GAP = 8;
const VIEWPORT_MARGIN = 12;
const TITLE_MAX = 200;
const BODY_MAX = 1000;

export type FeedbackPopoverProps = {
  isOpen: boolean;
  onClose: () => void;
  // Anchor: either an HTMLElement (for row-anchored popovers) or null
  // (then pops up near the FeedbackButton's parent — caller positions it).
  anchorEl?: HTMLElement | null;
  // Pre-fill the title (e.g., from a row's title). Caller can leave blank
  // for the freeform-from-FeedbackButton case.
  initialTitle?: string;
  // If set, the popover saves the note tagged to this row.
  sourceTable?: FeedbackSourceTable | null;
  sourceId?: string | null;
  dashboardSection?: string | null;
  // Optional "View all notes" link inside the popover footer; when
  // clicked, closes popover and calls this callback. Used by Agent C to
  // open the sidebar from the FeedbackButton's popover.
  onViewAll?: () => void;
};

type Position = { top: number; left: number };

// Compute fixed-position coords from an anchor rect. Prefer placing the
// popover to the LEFT of the anchor; if it would clip, try RIGHT; if
// still clipped, pin to viewport top-right corner.
function computePositionFromAnchor(rect: DOMRect): Position {
  const vw = typeof window === "undefined" ? 1024 : window.innerWidth;
  const vh = typeof window === "undefined" ? 768 : window.innerHeight;

  // Prefer LEFT of anchor.
  let left = rect.left - POPOVER_MAX_WIDTH - ANCHOR_GAP;
  let top = rect.top;

  if (left < VIEWPORT_MARGIN) {
    // Try right-of-anchor.
    left = rect.right + ANCHOR_GAP;
    if (left + POPOVER_MAX_WIDTH > vw - VIEWPORT_MARGIN) {
      // Pin top-right corner — slightly above-right of the button.
      left = vw - POPOVER_MAX_WIDTH - VIEWPORT_MARGIN;
      top = Math.max(VIEWPORT_MARGIN, rect.top - POPOVER_ESTIMATED_HEIGHT - ANCHOR_GAP);
    }
  }

  // Vertical clamp.
  if (top + POPOVER_ESTIMATED_HEIGHT > vh - VIEWPORT_MARGIN) {
    top = Math.max(VIEWPORT_MARGIN, vh - POPOVER_ESTIMATED_HEIGHT - VIEWPORT_MARGIN);
  }
  if (top < VIEWPORT_MARGIN) top = VIEWPORT_MARGIN;

  return { top, left };
}

// Fallback position when no anchor — top-right of viewport. Roughly
// above where the FeedbackButton sits (bottom-6 right-6).
function defaultPosition(): Position {
  const vw = typeof window === "undefined" ? 1024 : window.innerWidth;
  return {
    top: VIEWPORT_MARGIN,
    left: Math.max(VIEWPORT_MARGIN, vw - POPOVER_MAX_WIDTH - VIEWPORT_MARGIN),
  };
}

export function FeedbackPopover({
  isOpen,
  onClose,
  anchorEl,
  initialTitle,
  sourceTable,
  sourceId,
  dashboardSection,
  onViewAll,
}: FeedbackPopoverProps) {
  const createFeedback = useCreateFeedback();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  const [title, setTitle] = useState<string>(initialTitle ?? "");
  const [body, setBody] = useState<string>("");
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<Position>(() => defaultPosition());

  // Reset internal form state when the popover opens or the underlying
  // source/title changes between opens. sourceTable + sourceId are in the
  // deps so switching from row A to row B (which might share the same
  // initialTitle) still clears the body and any prior error.
  useEffect(() => {
    if (isOpen) {
      setTitle(initialTitle ?? "");
      setBody("");
      setError(null);
      setSaving(false);
    }
  }, [isOpen, initialTitle, sourceTable, sourceId]);

  // Compute position when opening. useLayoutEffect so the popover doesn't
  // flash at the default position before snapping into place.
  useLayoutEffect(() => {
    if (!isOpen) return;
    if (anchorEl) {
      const rect = anchorEl.getBoundingClientRect();
      setPosition(computePositionFromAnchor(rect));
    } else {
      setPosition(defaultPosition());
    }
  }, [isOpen, anchorEl]);

  // Reposition on viewport resize OR scroll while open — keeps the popover
  // anchored to its row even as the dashboard scrolls underneath. Scroll
  // listener uses capture so it fires for any scroll container in the
  // ancestor chain (not just window). rAF throttles to avoid scroll jank.
  useEffect(() => {
    if (!isOpen) return;
    const recomputePosition = () => {
      if (anchorEl) {
        setPosition(computePositionFromAnchor(anchorEl.getBoundingClientRect()));
      } else {
        setPosition(defaultPosition());
      }
    };
    let rafId = 0;
    const onEvent = () => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        recomputePosition();
      });
    };
    window.addEventListener("resize", onEvent);
    window.addEventListener("scroll", onEvent, { capture: true });
    return () => {
      window.removeEventListener("resize", onEvent);
      window.removeEventListener("scroll", onEvent, { capture: true });
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [isOpen, anchorEl]);

  // Auto-focus the title input on open.
  useEffect(() => {
    if (isOpen) {
      // Defer one tick so the input is mounted.
      const id = window.setTimeout(() => {
        titleInputRef.current?.focus();
        titleInputRef.current?.select();
      }, 0);
      return () => window.clearTimeout(id);
    }
  }, [isOpen]);

  // Escape-to-close + focus trap on Tab. Escape uses stopPropagation (not
  // preventDefault) so other listeners higher up the registration order
  // don't also fire — e.g., if a sidebar is open underneath, only the
  // most-recently-opened surface (this popover) closes. Tab/Shift+Tab
  // cycle focus within the popover so screen-reader / keyboard users
  // can't accidentally tab into the dashboard underneath.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "Tab" && containerRef.current) {
        const focusables = containerRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey) {
          if (active === first || !containerRef.current.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  // Outside-click closes. Use mousedown so the close beats any onClick
  // that might re-open the popover (e.g., the FeedbackButton itself).
  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (containerRef.current && containerRef.current.contains(target)) return;
      // Also ignore clicks inside the anchor element so clicking the
      // anchor toggles correctly via its own handler.
      if (anchorEl && anchorEl.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [isOpen, onClose, anchorEl]);

  if (!isOpen) return null;

  const trimmedTitle = title.trim();
  const canSave = trimmedTitle.length > 0 && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const res = await createFeedback({
      title: trimmedTitle.slice(0, TITLE_MAX),
      body: body.length > 0 ? body.slice(0, BODY_MAX) : null,
      dashboard_section: dashboardSection ?? null,
      source_table: sourceTable ?? null,
      source_id: sourceId ?? null,
    });
    if (!res.ok) {
      setError(res.error ?? "Could not save your note. Try again.");
      setSaving(false);
      return;
    }
    setTitle("");
    setBody("");
    setSaving(false);
    onClose();
  };

  const handleViewAll = () => {
    if (!onViewAll) return;
    onClose();
    onViewAll();
  };

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label="Add review note"
      style={{
        position: "fixed",
        top: position.top,
        left: position.left,
        width: POPOVER_MAX_WIDTH,
        zIndex: 50,
      }}
      className="rounded-lg border-[0.5px] border-gray-200 bg-white shadow-lg"
    >
      <div className="flex flex-col gap-2 p-3">
        <input
          ref={titleInputRef}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value.slice(0, TITLE_MAX))}
          placeholder="Comment title"
          maxLength={TITLE_MAX}
          disabled={saving}
          className="w-full rounded border-[0.5px] border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-900 disabled:opacity-50"
        />
        <div className="relative">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value.slice(0, BODY_MAX))}
            placeholder="What did you want to flag?"
            rows={4}
            maxLength={BODY_MAX}
            disabled={saving}
            className="w-full resize-none rounded border-[0.5px] border-gray-200 bg-white px-2 py-1.5 pb-5 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-900 disabled:opacity-50"
          />
          <span className="pointer-events-none absolute bottom-1.5 right-2 font-mono text-[11px] lowercase text-gray-400">
            {body.length}/{BODY_MAX}
          </span>
        </div>

        {error && (
          <p className="text-xs text-red-500" role="alert">
            {error}
          </p>
        )}

        <div className="mt-1 flex items-center justify-between">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="text-xs text-gray-500 hover:text-gray-900 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>

        {onViewAll && (
          <button
            type="button"
            onClick={handleViewAll}
            className="self-start text-[11px] text-gray-400 underline hover:text-gray-600"
          >
            View all notes
          </button>
        )}
      </div>
    </div>
  );
}
