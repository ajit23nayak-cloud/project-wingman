"use client";

// Email detail page, Supabase variant. Full read + write path.
//   Read: useEmail (Supabase RLS), useEmailBody (server-side Gmail fetch).
//   Write: useGenerateDraft / useUpdateDraft / useDeleteDraft / useSendDraft
//          — each invalidates the useEmail key so the page re-renders.
//
// Duplicate-send guard: after a successful send, we wait for the SWR
// revalidation to flip draft.status to 'sent' before navigating. If the
// post-send UPDATE silently failed, the draft stays unsent in the UI and
// the user sees a "sent — finalising" state with a manual Back link
// instead of seeing the Send button again.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEmail,
  useEmailBody,
  useGenerateDraft,
  useUpdateDraft,
  useDeleteDraft,
  useSendDraft,
  type DraftRow,
} from "@/lib/supabase/hooks";

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

const ACTION_ERROR_MESSAGES: Record<string, string> = {
  ...BODY_ERROR_MESSAGES,
  empty_draft: "Draft is empty — write something before sending.",
  already_sent: "This reply was already sent.",
  not_found_or_immutable:
    "Draft no longer editable. It may have been sent or removed.",
  email_not_found: "This email is no longer in your inbox.",
  llm_failed: "Could not generate a draft. Try again.",
  empty_draft_generated: "The model returned an empty draft. Try again.",
  upsert_failed: "Couldn't save the draft. Try again.",
  gmail_send_failed: "Gmail couldn't send the reply. Try again.",
};

function friendlyError(code: string | undefined | null): string {
  if (!code) return "Something went wrong.";
  return ACTION_ERROR_MESSAGES[code] ?? "Something went wrong. Please try again.";
}

export function EmailDetailView({ emailId }: { emailId: string }) {
  const router = useRouter();
  const { data: email, error: emailError } = useEmail(emailId);
  const { data: bodyResp, isLoading: bodyLoading } = useEmailBody(emailId);

  const generateDraft = useGenerateDraft();
  const updateDraft = useUpdateDraft();
  const deleteDraft = useDeleteDraft();
  const sendDraft = useSendDraft();

  const [editedDraft, setEditedDraft] = useState<string>("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isSkipping, setIsSkipping] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Local "we just hit send" flag. Cleared once the server row flips to
  // status='sent' via SWR revalidation. Prevents duplicate-send if the
  // post-send UPDATE silently failed.
  const [sentLocally, setSentLocally] = useState(false);

  // Sync the server's draft body into the textarea once on load (and on
  // regenerate). lastSyncedRef prevents the effect from clobbering local
  // edits as SWR re-renders.
  const lastSyncedDraftRef = useRef<string | null>(null);
  useEffect(() => {
    const serverBody = email?.drafts?.body ?? null;
    if (serverBody === null) {
      lastSyncedDraftRef.current = null;
      return;
    }
    if (lastSyncedDraftRef.current === serverBody) return;
    lastSyncedDraftRef.current = serverBody;
    setEditedDraft(serverBody);
  }, [email]);

  // Route back to dashboard once the server confirms the send.
  useEffect(() => {
    if (!sentLocally) return;
    if (email?.drafts?.status === "sent") {
      router.push("/dashboard");
    }
  }, [sentLocally, email, router]);

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
  const anyInFlight = isGenerating || isSending || isSkipping;

  const handleGenerate = async () => {
    setIsGenerating(true);
    setActionError(null);
    const res = await generateDraft(emailId);
    if (!res.ok) setActionError(friendlyError(res.error));
    setIsGenerating(false);
  };

  const handleRegenerate = () => {
    if (
      draft &&
      editedDraft !== draft.body &&
      !confirm("You have unsaved edits. Regenerating will discard them.")
    ) {
      return;
    }
    void handleGenerate();
  };

  const handleSend = async () => {
    if (!draft) return;
    setIsSending(true);
    setActionError(null);
    // Persist edits first so the server sends the latest text.
    if (editedDraft !== draft.body) {
      const upd = await updateDraft(draft.id, editedDraft, emailId);
      if (!upd.ok) {
        setActionError(friendlyError(upd.error));
        setIsSending(false);
        return;
      }
    }
    const res = await sendDraft(draft.id, emailId);
    if (res.ok) {
      // Don't navigate yet — wait for SWR to flip status to 'sent' via the
      // duplicate-send guard effect above.
      setSentLocally(true);
    } else {
      setActionError(friendlyError(res.error));
    }
    setIsSending(false);
  };

  const handleSkip = async () => {
    if (!draft) return;
    setIsSkipping(true);
    setActionError(null);
    const res = await deleteDraft(draft.id, emailId);
    if (res.ok) {
      router.push("/dashboard");
    } else {
      setActionError(friendlyError(res.error));
      setIsSkipping(false);
    }
  };

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
          ) : sentLocally ? (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4">
              <div className="text-sm text-green-800 font-medium">
                Reply sent — finalising…
              </div>
              <p className="text-xs text-gray-600 mt-2">
                Gmail accepted the reply. We&apos;re recording it now. If this
                takes more than a few seconds, return to the dashboard — the
                email will show as replied once everything catches up. Do not
                click Send again.
              </p>
              <div className="mt-3">
                <Link
                  href="/dashboard"
                  className="text-sm text-gray-700 hover:text-gray-900 underline"
                >
                  ← Back to dashboard
                </Link>
              </div>
            </div>
          ) : !hasDraft ? (
            <div>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={anyInFlight}
                className="rounded-md bg-black text-white px-3 py-1.5 text-sm font-medium hover:bg-gray-800 disabled:opacity-50"
              >
                {isGenerating ? "Generating…" : "Generate Draft"}
              </button>
              {actionError && (
                <p className="mt-3 text-sm text-red-600">{actionError}</p>
              )}
            </div>
          ) : (
            <div>
              <textarea
                value={editedDraft}
                onChange={(e) => setEditedDraft(e.target.value)}
                rows={8}
                disabled={anyInFlight}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-black focus:border-black disabled:opacity-50"
              />
              <div className="text-xs text-gray-500 mt-1">
                {editedDraft.length} chars
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={anyInFlight || editedDraft.trim().length === 0}
                  className="rounded-md bg-black text-white px-3 py-1.5 text-sm font-medium hover:bg-gray-800 disabled:opacity-50"
                >
                  {isSending ? "Sending…" : "Send Reply"}
                </button>
                <button
                  type="button"
                  onClick={handleSkip}
                  disabled={anyInFlight}
                  className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
                >
                  {isSkipping ? "Skipping…" : "Skip"}
                </button>
                <button
                  type="button"
                  onClick={handleRegenerate}
                  disabled={anyInFlight}
                  className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
                >
                  {isGenerating ? "Regenerating…" : "Regenerate"}
                </button>
              </div>
              {actionError && (
                <p className="mt-3 text-sm text-red-600">{actionError}</p>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
