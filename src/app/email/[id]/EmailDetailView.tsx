"use client";

// Email detail page, Supabase variant. Replaces the Convex live-query
// version. Read path only in this commit (A): metadata, body fetch, existing
// draft display. Write actions (Generate / Edit / Send / Skip) are rendered
// but DISABLED with a "Available in next commit" title — they wire up in
// Commit B alongside /api/drafts/* routes.

import { useState } from "react";
import Link from "next/link";
import { useEmail, useEmailBody, type DraftRow } from "@/lib/supabase/hooks";

const BADGE_STYLES: Record<string, string> = {
  urgent: "bg-red-100 text-red-800 border-red-200",
  important: "bg-blue-100 text-blue-800 border-blue-200",
  fyi: "bg-gray-100 text-gray-600 border-gray-200",
  archive: "bg-gray-50 text-gray-400 border-gray-200",
};

function formatRelativeTime(timestamp: number | undefined | null): string {
  if (!timestamp) return "never";
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function formatEmailTime(ms: number): string {
  const date = new Date(ms);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const BODY_ERROR_MESSAGES: Record<string, string> = {
  token_fetch_failed:
    "Could not refresh your Google token. Try reconnecting Gmail.",
  no_google_token:
    "Gmail isn't connected. Reconnect from the dashboard banner.",
  gmail_auth_failed:
    "Gmail rejected the request. Reconnect from the dashboard banner.",
  gmail_fetch_failed: "Gmail is temporarily unavailable. Try refreshing.",
  email_not_found: "This email is no longer in your inbox.",
};

export function EmailDetailView({ emailId }: { emailId: string }) {
  const { data: email, error: emailError } = useEmail(emailId);
  const { data: bodyResp, isLoading: bodyLoading } = useEmailBody(emailId);

  // Write-path local state (used by Commit B; declared now so the JSX
  // structure is stable across commits and the disabled buttons render).
  const [editedDraft, setEditedDraft] = useState<string>("");

  // Hard error first — RLS denied, network failure, or query threw.
  if (emailError) {
    return (
      <main className="min-h-screen p-6">
        <div className="max-w-4xl mx-auto">
          <Link
            href="/dashboard"
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            ← Back to dashboard
          </Link>
          <p className="mt-6 text-sm text-red-600">
            Could not load this email. {emailError.message}
          </p>
        </div>
      </main>
    );
  }

  // Loading shell — first paint while useEmail resolves.
  if (email === undefined) {
    return (
      <main className="min-h-screen p-6">
        <div className="max-w-4xl mx-auto">
          <p className="text-gray-500 text-sm">Loading…</p>
        </div>
      </main>
    );
  }

  // Soft not-found — email doesn't exist, was deleted, or RLS scoped it out.
  if (email === null) {
    return (
      <main className="min-h-screen p-6">
        <div className="max-w-4xl mx-auto">
          <Link
            href="/dashboard"
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            ← Back to dashboard
          </Link>
          <p className="mt-6 text-gray-700">Email not found.</p>
        </div>
      </main>
    );
  }

  const draft: DraftRow | null = email.drafts ?? null;
  const isSent = draft?.status === "sent";
  const hasDraft = !!draft && draft.body.trim().length > 0;

  // Initial textarea content. When Commit B wires editing, the local
  // `editedDraft` state takes over on first keystroke.
  const draftTextareaValue = editedDraft.length > 0 ? editedDraft : (draft?.body ?? "");

  return (
    <main className="min-h-screen p-6">
      <div className="max-w-4xl mx-auto">
        <header className="flex items-center justify-between gap-3">
          <Link
            href="/dashboard"
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            ← Back to dashboard
          </Link>
          {email.classification && (
            <span
              className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${BADGE_STYLES[email.classification]}`}
            >
              {email.classification}
            </span>
          )}
        </header>

        <div className="mt-6 rounded-lg border border-gray-200 p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wide">From</div>
          <div className="text-sm font-medium mt-0.5 break-all">
            {email.from_address}
          </div>
          <div className="text-xs text-gray-500 uppercase tracking-wide mt-3">
            Subject
          </div>
          <div className="text-sm font-medium mt-0.5">
            {email.subject || "(no subject)"}
          </div>
          <div className="text-xs text-gray-500 uppercase tracking-wide mt-3">
            Received
          </div>
          <div className="text-sm mt-0.5">
            {formatEmailTime(email.received_at)} ·{" "}
            <span className="text-gray-500">
              {formatRelativeTime(email.received_at)}
            </span>
          </div>
          {email.classification_reason && (
            <>
              <div className="text-xs text-gray-500 uppercase tracking-wide mt-3">
                Classifier reason
              </div>
              <div className="text-sm mt-0.5 italic text-gray-700">
                {email.classification_reason}
              </div>
            </>
          )}
        </div>

        <section className="mt-6">
          <h2 className="text-sm font-semibold text-gray-700 mb-2">Full email</h2>
          {bodyLoading ? (
            <p className="text-sm text-gray-500">Loading body…</p>
          ) : (
            <>
              {bodyResp?.error && (
                <p className="text-sm text-red-600 mb-2">
                  {BODY_ERROR_MESSAGES[bodyResp.error] ??
                    "Could not load the full body — showing snippet."}
                </p>
              )}
              {bodyResp?.bodyText && bodyResp.bodyText.length > 0 ? (
                <pre className="whitespace-pre-wrap text-sm text-gray-800 max-h-[60vh] overflow-y-auto rounded-lg border border-gray-200 p-3 bg-gray-50">
                  {bodyResp.bodyText}
                </pre>
              ) : (
                <p className="text-sm text-gray-500">{email.snippet}</p>
              )}
            </>
          )}
        </section>

        <section className="mt-8">
          <h2 className="text-sm font-semibold text-gray-700 mb-2">
            Draft reply
          </h2>

          {isSent ? (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4">
              <div className="text-sm text-green-800 font-medium">
                Replied {formatRelativeTime(draft?.replied_at)}
              </div>
              {draft?.body && (
                <pre className="whitespace-pre-wrap text-sm text-gray-800 mt-3 rounded-md bg-white border border-green-100 p-3">
                  {draft.body}
                </pre>
              )}
            </div>
          ) : !hasDraft ? (
            <div>
              <button
                type="button"
                disabled
                title="Available in next commit"
                className="rounded-md bg-black text-white px-3 py-1.5 text-sm font-medium opacity-50 cursor-not-allowed"
              >
                Generate Draft
              </button>
              <p className="mt-2 text-xs text-gray-500">
                Draft generation lands in the next commit.
              </p>
            </div>
          ) : (
            <div>
              <textarea
                value={draftTextareaValue}
                onChange={(e) => setEditedDraft(e.target.value)}
                rows={8}
                disabled
                title="Edit + send available in next commit"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono leading-relaxed disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <div className="text-xs text-gray-500 mt-1">
                {draftTextareaValue.length} chars
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled
                  title="Available in next commit"
                  className="rounded-md bg-black text-white px-3 py-1.5 text-sm font-medium opacity-50 cursor-not-allowed"
                >
                  Send Reply
                </button>
                <button
                  type="button"
                  disabled
                  title="Available in next commit"
                  className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium opacity-50 cursor-not-allowed"
                >
                  Skip
                </button>
                <button
                  type="button"
                  disabled
                  title="Available in next commit"
                  className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium opacity-50 cursor-not-allowed"
                >
                  Regenerate
                </button>
              </div>
              <p className="mt-2 text-xs text-gray-500">
                Edit + send + skip + regenerate land in the next commit.
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
