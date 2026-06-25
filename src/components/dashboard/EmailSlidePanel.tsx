"use client";

// Slide-in email detail panel (Mega-commit A P0.3). Replaces the prior
// "open /email/[id] in a new tab" pattern for dashboard email rows. The
// /email/[id] route still works for direct URL access — both render the
// same EmailDetailBody under the hood.
//
// Behavior:
// - emailId=null → renders nothing.
// - emailId set → renders a fixed overlay backdrop + right-edge panel.
// - Esc key or backdrop click → onClose().
// - On open: focus moves to the close button. On close: focus restores to
//   whatever was focused before.

import { useEffect, useRef } from "react";
import { EmailDetailBody } from "@/app/email/[id]/EmailDetailBody";

export type EmailSlidePanelProps = {
  emailId: string | null;
  onClose: () => void;
};

export function EmailSlidePanel({ emailId, onClose }: EmailSlidePanelProps) {
  const isOpen = !!emailId;
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  // Esc-to-close.
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

  // Focus management — save the previously focused element when opening,
  // restore it when closing.
  useEffect(() => {
    if (isOpen) {
      lastFocusedRef.current =
        typeof document !== "undefined"
          ? (document.activeElement as HTMLElement | null)
          : null;
      // Defer to next tick so the close button is in the DOM.
      const id = window.setTimeout(() => closeBtnRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    } else {
      lastFocusedRef.current?.focus?.();
    }
  }, [isOpen]);

  if (!isOpen || !emailId) return null;

  return (
    <>
      <div
        aria-hidden="true"
        className="fixed inset-0 z-40 bg-black/30"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Email detail"
        className="fixed top-0 right-0 z-50 h-screen w-full max-w-2xl overflow-y-auto bg-white shadow-2xl"
      >
        <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-gray-200 bg-white px-6 py-3">
          <span className="text-sm font-medium text-gray-700">Email</span>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label="Close email panel"
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
          >
            <svg
              width="18"
              height="18"
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
        <div className="px-6 py-4">
          <EmailDetailBody
            emailId={emailId}
            mode="panel"
            onAfterSend={onClose}
          />
        </div>
      </aside>
    </>
  );
}
