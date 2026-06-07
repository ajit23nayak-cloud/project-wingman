"use client";

// Dashboard, Supabase/SWR variant. Replaces the Convex live-query version.
// Data flow: useMe loads first (gates the rest), useCounts + useEmails query
// Postgres directly via the Clerk JWT, useTriggerIngest fires the server
// ingest route then invalidates the keys above.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useUser, UserButton } from "@clerk/nextjs";
import {
  useMe,
  useCounts,
  useEmails,
  useTriggerIngest,
  type Counts,
  type FilterValue,
  type EmailRow,
} from "@/lib/supabase/hooks";

const PAGE_SIZE = 50;

const FILTERS: { value: FilterValue; label: string }[] = [
  { value: "all", label: "All" },
  { value: "urgent", label: "Urgent" },
  { value: "important", label: "Important" },
  { value: "fyi", label: "FYI" },
  { value: "archive", label: "Archive" },
];

function countFor(counts: Counts | undefined, value: FilterValue): number | null {
  if (!counts) return null;
  if (value === "all") return counts.total;
  return counts[value];
}

const BADGE_STYLES: Record<NonNullable<EmailRow["classification"]>, string> = {
  urgent: "bg-red-100 text-red-800 border-red-200",
  important: "bg-blue-100 text-blue-800 border-blue-200",
  fyi: "bg-gray-100 text-gray-600 border-gray-200",
  archive: "bg-gray-50 text-gray-400 border-gray-200",
};

function formatRelativeTime(timestamp: number | null | undefined): string {
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
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated: "You need to sign in.",
  no_google_token:
    "Gmail access not connected. Please sign out and sign in again with Gmail permissions.",
  token_fetch_failed:
    "Could not refresh your Google token. Try signing in again.",
  gmail_fetch_failed:
    "Gmail is temporarily unavailable. Please try refreshing.",
};

export function DashboardView() {
  const router = useRouter();
  const { user: clerkUser, isLoaded, isSignedIn } = useUser();
  useEffect(() => {
    if (isLoaded && !isSignedIn) router.replace("/");
  }, [isLoaded, isSignedIn, router]);

  const [filter, setFilter] = useState<FilterValue>("all");

  const { data: me, error: meError } = useMe();
  const { data: counts, error: countsError } = useCounts();
  const emailsHook = useEmails(filter, PAGE_SIZE);

  const triggerIngest = useTriggerIngest();

  const [isIngesting, setIsIngesting] = useState(false);
  const [firstIngestCount, setFirstIngestCount] = useState<number | null>(null);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const autoTriggeredRef = useRef(false);

  const runIngest = async (isAuto: boolean) => {
    setIsIngesting(true);
    setIngestError(null);
    try {
      const res = await triggerIngest();
      if (!res.ok && res.error) {
        setIngestError(ERROR_MESSAGES[res.error] ?? `Error: ${res.error}`);
      } else if (res.ok && isAuto) {
        setFirstIngestCount(res.ingested ?? 0);
      }
    } catch (err) {
      setIngestError(
        err instanceof Error
          ? err.message
          : "Unexpected error during ingestion.",
      );
    } finally {
      setIsIngesting(false);
    }
  };

  // Auto-fire first ingest when /api/dashboard/me returns lastIngestedAt: null.
  useEffect(() => {
    if (me === undefined) return;
    if (autoTriggeredRef.current) return;
    if (me.lastIngestedAt === null) {
      autoTriggeredRef.current = true;
      runIngest(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  const firstName = clerkUser?.firstName ?? clerkUser?.fullName ?? "there";

  if (!isLoaded) {
    return <main className="min-h-screen p-6" />;
  }
  if (!isSignedIn) {
    return <main className="min-h-screen p-6" />;
  }
  // Loading shell: wait for me + counts before painting.
  if (me === undefined || counts === undefined) {
    return <main className="min-h-screen p-6" />;
  }

  const emails: EmailRow[] = emailsHook.data ? emailsHook.data.flat() : [];
  const lastPage = emailsHook.data
    ? emailsHook.data[emailsHook.data.length - 1]
    : undefined;
  const reachedEnd = !!lastPage && lastPage.length < PAGE_SIZE;
  const loadingFirstPage =
    !emailsHook.data && !emailsHook.error && emailsHook.isLoading;
  const loadingMore = emailsHook.isValidating && !loadingFirstPage;

  return (
    <main className="min-h-screen p-6">
      <header className="flex justify-between items-center max-w-4xl mx-auto">
        <h1 className="text-xl font-semibold">Project Wingman</h1>
        <div className="flex items-center gap-3">
          <button
            onClick={() => runIngest(false)}
            disabled={isIngesting}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
          >
            {isIngesting ? "Refreshing..." : "Refresh inbox"}
          </button>
          <UserButton />
        </div>
      </header>

      {me?.gmailReauthNeeded && (
        <div className="max-w-4xl mx-auto mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h3 className="font-semibold text-amber-900">
            Your Gmail connection expired
          </h3>
          <p className="mt-1 text-sm text-amber-800">
            Wingman can&apos;t reach your inbox until you reconnect. Takes 10
            seconds.
            {me.gmailReauthNeededAt && (
              <>
                {" "}
                <span className="text-amber-700">
                  Stopped working{" "}
                  {formatRelativeTime(
                    new Date(me.gmailReauthNeededAt).getTime(),
                  )}
                  .
                </span>
              </>
            )}
          </p>
          <Link
            href="/account"
            className="mt-3 inline-block rounded-md bg-amber-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800"
          >
            Reconnect Gmail
          </Link>
        </div>
      )}

      <section className="max-w-4xl mx-auto mt-10">
        <h2 className="text-2xl font-semibold">Welcome, {firstName}.</h2>

        {isIngesting && firstIngestCount === null && (
          <p className="mt-3 text-gray-600">Connecting to your inbox...</p>
        )}

        {firstIngestCount !== null && !isIngesting && (
          <p className="mt-3 text-gray-700">
            Found {firstIngestCount} emails from the last 30 days.
          </p>
        )}

        {ingestError && (
          <p className="mt-3 text-sm text-red-600">{ingestError}</p>
        )}

        {(meError || countsError) && (
          <p className="mt-3 text-sm text-red-600">Could not load. Refresh.</p>
        )}

        <div className="mt-6 grid grid-cols-2 gap-4 max-w-md">
          <div className="rounded-lg border border-gray-200 p-4">
            <div className="text-xs text-gray-500 uppercase tracking-wide">
              Emails ingested
            </div>
            <div className="text-2xl font-semibold mt-1">
              {counts?.total ?? "—"}
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 p-4">
            <div className="text-xs text-gray-500 uppercase tracking-wide">
              Last sync
            </div>
            <div className="text-2xl font-semibold mt-1">
              {formatRelativeTime(me?.lastIngestedAt)}
            </div>
          </div>
        </div>

        <div className="mt-6">
          <button
            disabled
            title="Available next session"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
          >
            Classify all
          </button>
        </div>
      </section>

      <section className="max-w-4xl mx-auto mt-10">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            {FILTERS.map((f) => {
              const c = countFor(counts, f.value);
              return (
                <button
                  key={f.value}
                  onClick={() => setFilter(f.value)}
                  className={`text-xs px-2.5 py-1 rounded-full border transition ${
                    filter === f.value
                      ? "bg-black text-white border-black"
                      : "bg-white text-gray-600 border-gray-300 hover:border-gray-500"
                  }`}
                >
                  {f.label}
                  {c !== null ? ` (${c})` : ""}
                </button>
              );
            })}
          </div>
        </div>

        {counts && counts.pending > 0 && (
          <p className="mb-3 text-sm text-gray-600">
            Classifying your inbox… ({counts.pending} remaining)
          </p>
        )}

        {emailsHook.error ? (
          <p className="mt-3 text-sm text-red-600">Could not load. Refresh.</p>
        ) : loadingFirstPage ? (
          <p className="text-gray-500 text-sm">Loading...</p>
        ) : emails.length === 0 ? (
          <p className="text-gray-500 text-sm">No emails in this view.</p>
        ) : (
          <>
            <ul className="divide-y divide-gray-200 border-y border-gray-200">
              {emails.map((email) => {
                const isArchive = email.classification === "archive";
                const draft = Array.isArray(email.drafts)
                  ? email.drafts[0]
                  : email.drafts;
                const isSent = draft?.status === "sent";
                const fade = isArchive || isSent;
                return (
                  <li key={email.id}>
                    <div
                      className={`block py-3 px-2 -mx-2 hover:bg-gray-50 ${fade ? "opacity-60" : ""}`}
                    >
                      <div className="flex justify-between items-baseline gap-3">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          {email.classification && (
                            <span
                              className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border shrink-0 ${
                                BADGE_STYLES[email.classification]
                              }`}
                            >
                              {email.classification}
                            </span>
                          )}
                          {isSent && (
                            <span
                              className="text-green-600 text-sm shrink-0"
                              title="Replied"
                              aria-label="Replied"
                            >
                              ✓
                            </span>
                          )}
                          <span className="font-medium text-sm truncate">
                            {email.from_address}
                          </span>
                        </div>
                        <span className="text-xs text-gray-500 shrink-0">
                          {formatEmailTime(email.received_at)}
                        </span>
                      </div>
                      <div className="text-sm font-medium mt-0.5 truncate">
                        {email.subject || "(no subject)"}
                      </div>
                      <div className="text-sm text-gray-600 mt-0.5 line-clamp-1">
                        {email.snippet}
                      </div>
                      {email.classification_reason && (
                        <div className="text-xs text-gray-500 mt-1 italic">
                          {email.classification_reason}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {!reachedEnd && !loadingMore && (
              <div className="mt-3 flex justify-center">
                <button
                  onClick={() => emailsHook.setSize((s) => s + 1)}
                  className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50"
                >
                  Load more
                </button>
              </div>
            )}
            {loadingMore && (
              <p className="mt-3 text-center text-xs text-gray-500">
                Loading more...
              </p>
            )}
          </>
        )}
      </section>
    </main>
  );
}
