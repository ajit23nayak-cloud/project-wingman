"use client";

// Snooze quick-pick popover anchored to a row's snooze button (Mega-commit
// B 13a #6). 4 presets + 1 custom datetime input. Esc + outside-click
// dismiss. Pattern modeled on FeedbackPopover — keeps the UX consistent.

import { useEffect, useRef, useState } from "react";

export type SnoozePreset = {
  label: string;
  computeUntil: () => Date;
};

const PRESETS: SnoozePreset[] = [
  {
    label: "1 hour",
    computeUntil: () => new Date(Date.now() + 60 * 60 * 1000),
  },
  {
    label: "End of day",
    computeUntil: () => {
      const d = new Date();
      d.setHours(22, 0, 0, 0);
      // If it's already past 10pm local, snooze to next morning 8am.
      if (d.getTime() < Date.now()) {
        d.setDate(d.getDate() + 1);
        d.setHours(8, 0, 0, 0);
      }
      return d;
    },
  },
  {
    label: "Tomorrow morning",
    computeUntil: () => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d;
    },
  },
  {
    label: "Next week",
    computeUntil: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  },
];

export type SnoozePopoverProps = {
  isOpen: boolean;
  onClose: () => void;
  anchorEl: HTMLElement | null;
  onPick: (snoozedUntil: Date) => void;
};

export function SnoozePopover({
  isOpen,
  onClose,
  anchorEl,
  onPick,
}: SnoozePopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [customValue, setCustomValue] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Anchor-relative positioning. Below the anchor + right-aligned to it.
  // Flip to above if there's no room below.
  useEffect(() => {
    if (!isOpen || !anchorEl) {
      setPos(null);
      return;
    }
    const rect = anchorEl.getBoundingClientRect();
    const POPOVER_HEIGHT_EST = 220;
    const POPOVER_WIDTH = 220;
    const spaceBelow = window.innerHeight - rect.bottom;
    const top =
      spaceBelow >= POPOVER_HEIGHT_EST
        ? rect.bottom + window.scrollY + 6
        : rect.top + window.scrollY - POPOVER_HEIGHT_EST - 6;
    const left = Math.max(
      8,
      Math.min(
        rect.right + window.scrollX - POPOVER_WIDTH,
        window.scrollX + window.innerWidth - POPOVER_WIDTH - 8,
      ),
    );
    setPos({ top, left });
  }, [isOpen, anchorEl]);

  // Esc to dismiss.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  // Outside-click dismiss. The check excludes the anchor itself so clicking
  // the button twice opens/closes cleanly.
  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (anchorEl?.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [isOpen, anchorEl, onClose]);

  if (!isOpen || !pos) return null;

  const pick = (d: Date) => {
    onPick(d);
    onClose();
  };

  const handleCustom = () => {
    if (!customValue) return;
    const d = new Date(customValue);
    if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) return;
    pick(d);
  };

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Snooze until"
      className="absolute z-50 w-[220px] rounded-lg border border-gray-200 bg-white shadow-lg"
      style={{ top: pos.top, left: pos.left }}
    >
      <div className="border-b border-gray-100 px-3 py-2 text-[11px] font-medium lowercase text-gray-500">
        snooze until
      </div>
      <ul className="py-1">
        {PRESETS.map((p) => (
          <li key={p.label}>
            <button
              type="button"
              onClick={() => pick(p.computeUntil())}
              className="block w-full px-3 py-1.5 text-left text-sm text-gray-800 hover:bg-gray-50"
            >
              {p.label}
            </button>
          </li>
        ))}
      </ul>
      <div className="border-t border-gray-100 px-3 py-2">
        <label className="block text-[11px] text-gray-500 mb-1">
          Pick a time
        </label>
        <div className="flex items-center gap-1">
          <input
            type="datetime-local"
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            className="flex-1 rounded border border-gray-300 px-1.5 py-1 text-xs focus:border-gray-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={handleCustom}
            className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50"
            disabled={!customValue}
          >
            ok
          </button>
        </div>
      </div>
    </div>
  );
}
