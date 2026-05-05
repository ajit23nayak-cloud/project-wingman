"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Doc, Id } from "../../../../convex/_generated/dataModel";

const BADGE_STYLES: Record<NonNullable<Doc<"emails">["classification"]>, string> =
  {
    urgent: "bg-red-100 text-red-800 border-red-200",
    important: "bg-blue-100 text-blue-800 border-blue-200",
    fyi: "bg-gray-100 text-gray-600 border-gray-200",
    archive: "bg-gray-50 text-gray-400 border-gray-200",
  };

function formatRelativeTime(timestamp: number | undefined): string {
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

const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated: "You need to sign in.",
  user_not_found: "User account not initialised yet — try refreshing.",
  email_not_found: "This email is no longer in your inbox.",
  forbidden: "You don't have access to this email.",
  no_draft: "No draft to send. Generate one first.",
  not_unsent: "This reply was already sent.",
  no_google_token:
    "Gmail access not connected. Sign out and back in with Gmail permissions.",
  token_fetch_failed:
    "Could not refresh your Google token. Try signing in again.",
  gmail_fetch_failed:
    "Gmail is temporarily unavailable. Please try again.",
};

function friendlyError(code: string | undefined | null): string {
  if (!code) return "Something went wrong.";
  return ERROR_MESSAGES[code] ?? "Something went wrong. Please try again.";
}

export function EmailDetailView({ emailId }: { emailId: Id<"emails"> }) {
  const router = useRouter();
  const email = useQuery(api.inbox.getEmailById, { emailId });

  const fetchBody = useAction(api.emailBody.fetchEmailBody);
  const generateDraft = useAction(api.draftReply.generateDraftReply);
  const sendReply = useAction(api.sendReply.sendReplyAction);
  const updateDraftText = useMutation(api.inbox.updateDraftReplyText);
  const skipReply = useMutation(api.inbox.skipReply);

  const [bodyText, setBodyText] = useState<string>("");
  const [bodyLoading, setBodyLoading] = useState<boolean>(false);
  const [bodyError, setBodyError] = useState<string | null>(null);

  const [editedDraft, setEditedDraft] = useState<string>("");
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [isSending, setIsSending] = useState<boolean>(false);
  const [isSkipping, setIsSkipping] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Set to true once Gmail accepts the reply. We DO NOT auto-route until the
  // server-side row update lands (replyStatus → "sent" via reactivity), to
  // prevent a duplicate-send if the post-send mutation failed silently.
  const [sentLocally, setSentLocally] = useState<boolean>(false);

  const fetchedBodyRef = useRef<Id<"emails"> | null>(null);
  const lastSyncedDraftRef = useRef<string | null>(null);

  useEffect(() => {
    if (!email) return;
    if (fetchedBodyRef.current === emailId) return;
    if (!email.gmailMessageId) return;
    fetchedBodyRef.current = emailId;
    // Clear any prior body so we don't render the previous email's content
    // while the new fetch is in flight.
    setBodyText("");
    setBodyLoading(true);
    setBodyError(null);
    fetchBody({ emailId })
      .then((res) => {
        if (res.error) {
          setBodyError(friendlyError(res.error));
          setBodyText(res.bodyText ?? "");
        } else {
          setBodyText(res.bodyText ?? "");
        }
      })
      .catch((err) => {
        setBodyError(err instanceof Error ? err.message : "Could not load body.");
      })
      .finally(() => setBodyLoading(false));
  }, [email, emailId, fetchBody]);

  useEffect(() => {
    if (!email) return;
    const serverDraft = email.draftReply;
    if (serverDraft === null || serverDraft === undefined) {
      lastSyncedDraftRef.current = null;
      return;
    }
    if (lastSyncedDraftRef.current === serverDraft) return;
    lastSyncedDraftRef.current = serverDraft;
    setEditedDraft(serverDraft);
  }, [email]);

  // Once the server row flips to "sent" after a Send, route back to dashboard.
  // This is the second half of the duplicate-send guard: we only route after
  // the DB confirms the reply was recorded.
  useEffect(() => {
    if (!sentLocally) return;
    if (!email) return;
    if (email.replyStatus === "sent") {
      router.push("/dashboard");
    }
  }, [sentLocally, email, router]);

  const handleGenerate = async () => {
    setIsGenerating(true);
    setActionError(null);
    try {
      const res = await generateDraft({ emailId });
      if (res === null) {
        setActionError("Could not generate. Try again.");
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unexpected error.");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRegenerateClick = () => {
    if (
      email &&
      email.draftReply !== null &&
      editedDraft !== email.draftReply &&
      !confirm("You have unsaved edits. Regenerating will discard them.")
    ) {
      return;
    }
    void handleGenerate();
  };

  const handleSend = async () => {
    if (!email) return;
    setIsSending(true);
    setActionError(null);
    try {
      if (editedDraft !== email.draftReply) {
        await updateDraftText({ emailId, draft: editedDraft });
      }
      const res = await sendReply({ emailId });
      if (res.success) {
        // Don't route yet — wait for the server row to flip to replyStatus
        // "sent". The watcher effect below routes once it lands. If the post-
        // send mutation silently failed, the user sees a "sent — finalising"
        // state with a manual Back link instead of seeing the Send button
        // again (which would re-send).
        setSentLocally(true);
      } else {
        setActionError(friendlyError(res.error));
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unexpected error.");
    } finally {
      setIsSending(false);
    }
  };

  const handleSkip = async () => {
    setIsSkipping(true);
    setActionError(null);
    try {
      await skipReply({ emailId });
      router.push("/dashboard");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unexpected error.");
    } finally {
      setIsSkipping(false);
    }
  };


  if (email === undefined) {
    return (
      <main className="min-h-screen p-6">
        <div className="max-w-4xl mx-auto">
          <p className="text-gray-500 text-sm">Loading…</p>
        </div>
      </main>
    );
  }

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

  const isSent = email.replyStatus === "sent";
  const hasDraft = email.draftReply !== null && email.draftReply !== undefined;
  const anyInFlight = isGenerating || isSending || isSkipping;

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
              className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${
                BADGE_STYLES[email.classification]
              }`}
            >
              {email.classification}
            </span>
          )}
        </header>

        <div className="mt-6 rounded-lg border border-gray-200 p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wide">
            From
          </div>
          <div className="text-sm font-medium mt-0.5 break-all">
            {email.fromAddress}
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
            {formatEmailTime(email.receivedAt)} ·{" "}
            <span className="text-gray-500">
              {formatRelativeTime(email.receivedAt)}
            </span>
          </div>
        </div>

        <section className="mt-6">
          <h2 className="text-sm font-semibold text-gray-700 mb-2">
            Full email
          </h2>
          {bodyLoading ? (
            <p className="text-sm text-gray-500">Loading body…</p>
          ) : (
            <>
              {bodyError && (
                <p className="text-sm text-red-600 mb-2">{bodyError}</p>
              )}
              {bodyText ? (
                <pre className="whitespace-pre-wrap text-sm text-gray-800 max-h-[60vh] overflow-y-auto rounded-lg border border-gray-200 p-3 bg-gray-50">
                  {bodyText}
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
                Replied {formatRelativeTime(email.repliedAt)}
              </div>
              {email.draftReply && (
                <pre className="whitespace-pre-wrap text-sm text-gray-800 mt-3 rounded-md bg-white border border-green-100 p-3">
                  {email.draftReply}
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
                takes more than a few seconds, return to the dashboard and
                refresh — the email will show as replied once everything
                catches up. Do not click Send again.
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
                  onClick={handleRegenerateClick}
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
