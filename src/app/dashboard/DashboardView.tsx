"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useUser, UserButton } from "@clerk/nextjs";
import { useAction, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Doc } from "../../../convex/_generated/dataModel";

const PAGE_SIZE = 50;

type FilterValue = "all" | "urgent" | "important" | "fyi" | "archive";

const FILTERS: { value: FilterValue; label: string }[] = [
  { value: "all", label: "All" },
  { value: "urgent", label: "Urgent" },
  { value: "important", label: "Important" },
  { value: "fyi", label: "FYI" },
  { value: "archive", label: "Archive" },
];

function countFor(
  counts:
    | { total: number; urgent: number; important: number; fyi: number; archive: number }
    | undefined,
  value: FilterValue,
): number | null {
  if (!counts) return null;
  if (value === "all") return counts.total;
  return counts[value];
}

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
  // Stale-render guard: while Clerk is still resolving the session, do not
  // fire any Convex query. After it resolves, if there's no signed-in user
  // (sign-out from another tab, expired session), bounce to /. Otherwise
  // the dashboard renders its empty-auth state mid-flight and the Convex
  // queries return null, which looks like a logged-in user with zero data.
  const authReady = isLoaded && isSignedIn;
  useEffect(() => {
    if (isLoaded && !isSignedIn) router.replace("/");
  }, [isLoaded, isSignedIn, router]);

  const convexUser = useQuery(
    api.users.currentUser,
    authReady ? {} : "skip",
  );
  const counts = useQuery(
    api.inbox.getClassificationCounts,
    authReady ? {} : "skip",
  );
  const totalCount = counts?.total;
  const ingestEmails = useAction(api.emails.ingestEmails);
  const testGemini = useAction(api.llm.testGemini);
  const classifyAllPending = useAction(api.inbox.classifyAllPending);

  const [filter, setFilter] = useState<FilterValue>("all");
  const [isClassifying, setIsClassifying] = useState(false);
  const progress = convexUser?.classificationProgress;
  // A progress doc whose startedAt is older than this with no completedAt is
  // assumed to be from a crashed/hung run, not an active one.
  const STALE_PROGRESS_MS = 30 * 60 * 1000;
  const isProgressActive =
    !!progress &&
    progress.completedAt === undefined &&
    Date.now() - progress.startedAt < STALE_PROGRESS_MS;
  const liveClassifying = isClassifying || isProgressActive;

  // Bandwidth rule: drop the list subscription while classifyAllPending is
  // running. Progress is observed via the small currentUser doc instead.
  const paginated = usePaginatedQuery(
    api.inbox.listPaginated,
    !authReady || liveClassifying ? "skip" : { classification: filter },
    { initialNumItems: PAGE_SIZE },
  );
  const emails = paginated.results;
  const listStatus = paginated.status;
  const loadMore = paginated.loadMore;

  const [isIngesting, setIsIngesting] = useState(false);
  const [firstIngestCount, setFirstIngestCount] = useState<number | null>(null);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [aiTestResult, setAiTestResult] = useState<string | null>(null);
  const [aiTesting, setAiTesting] = useState(false);
  const [classifySummary, setClassifySummary] = useState<string | null>(null);
  const autoTriggeredRef = useRef(false);

  const runIngest = async (isAuto: boolean) => {
    setIsIngesting(true);
    setIngestError(null);
    try {
      const res = await ingestEmails();
      if (res.error) {
        setIngestError(ERROR_MESSAGES[res.error] ?? `Error: ${res.error}`);
      } else if (isAuto) {
        setFirstIngestCount(res.count);
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

  useEffect(() => {
    if (!authReady) return;
    if (convexUser === undefined) return;
    if (autoTriggeredRef.current) return;
    if (convexUser === null || !convexUser.lastIngestedAt) {
      autoTriggeredRef.current = true;
      runIngest(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, convexUser]);

  const runAiTest = async () => {
    setAiTesting(true);
    setAiTestResult(null);
    try {
      const res = await testGemini();
      setAiTestResult(res.error ? `Error: ${res.error}` : res.text);
    } catch (err) {
      setAiTestResult(
        err instanceof Error ? err.message : "Unexpected error.",
      );
    } finally {
      setAiTesting(false);
    }
  };

  const runClassifyAll = async (mode: "pending" | "failed" = "pending") => {
    // The action no longer waits for completion — it lists work, schedules
    // chunk 0, and returns. Final totals come from the progress doc once
    // completedAt is set (see useEffect below).
    setIsClassifying(true);
    setClassifySummary(null);
    try {
      const res = await classifyAllPending({ mode });
      if (!res.scheduled) {
        setClassifySummary(res.message);
      }
    } catch (err) {
      setClassifySummary(
        err instanceof Error ? `Error: ${err.message}` : "Unexpected error.",
      );
    } finally {
      setIsClassifying(false);
    }
  };

  // When a classification run finishes (completedAt stamped), compute and
  // display the final summary string from the progress doc fields.
  const lastSummaryKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!progress || progress.completedAt === undefined) return;
    const key = `${progress.startedAt}-${progress.completedAt}`;
    if (lastSummaryKeyRef.current === key) return;
    lastSummaryKeyRef.current = key;
    const label = progress.mode === "failed" ? "Retried" : "Classified";
    const tokens = progress.inputTokens + progress.outputTokens;
    const costInr = (progress.totalToProcess * 0.005).toFixed(2);
    setClassifySummary(
      `${label} ${progress.classified}/${progress.totalToProcess}` +
        (progress.failed ? `, ${progress.failed} failed` : "") +
        ` · ~₹${costInr} · ${tokens} tokens`,
    );
  }, [progress]);

  const firstName = clerkUser?.firstName ?? clerkUser?.fullName ?? "there";

  if (!isLoaded) {
    return <main className="min-h-screen p-6" />;
  }
  if (!isSignedIn) {
    // Effect above is redirecting; render nothing so the previous user's
    // data never flashes during the bounce.
    return <main className="min-h-screen p-6" />;
  }

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

        <div className="mt-6 grid grid-cols-2 gap-4 max-w-md">
          <div className="rounded-lg border border-gray-200 p-4">
            <div className="text-xs text-gray-500 uppercase tracking-wide">
              Emails ingested
            </div>
            <div className="text-2xl font-semibold mt-1">
              {totalCount ?? "—"}
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 p-4">
            <div className="text-xs text-gray-500 uppercase tracking-wide">
              Last sync
            </div>
            <div className="text-2xl font-semibold mt-1">
              {formatRelativeTime(convexUser?.lastIngestedAt)}
            </div>
          </div>
        </div>

        <div className="mt-6">
          <button
            onClick={runAiTest}
            disabled={aiTesting}
            className="rounded-md bg-black text-white px-3 py-1.5 text-sm font-medium hover:bg-gray-800 disabled:opacity-50"
          >
            {aiTesting ? "Testing..." : "Test AI Connection"}
          </button>
          {aiTestResult && (
            <div className="mt-3 inline-block ml-3 text-sm text-gray-700 bg-gray-50 px-3 py-1.5 rounded-md border border-gray-200">
              {aiTestResult}
            </div>
          )}
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
          <div className="flex items-center gap-3">
            {isProgressActive && progress && progress.totalToProcess > 0 && (
              <span className="text-xs text-gray-600">
                Classifying {progress.processed}/{progress.totalToProcess}...
              </span>
            )}
            {classifySummary && !liveClassifying && (
              <span className="text-xs text-gray-600">{classifySummary}</span>
            )}
            <button
              onClick={() => runClassifyAll("pending")}
              disabled={liveClassifying}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
            >
              {liveClassifying ? "Classifying..." : "Classify all"}
            </button>
            {counts && counts.failed > 0 && (
              <button
                onClick={() => runClassifyAll("failed")}
                disabled={liveClassifying}
                className="rounded-md border border-amber-400 bg-amber-50 text-amber-900 px-3 py-1.5 text-sm font-medium hover:bg-amber-100 disabled:opacity-50"
              >
                Retry failed ({counts.failed})
              </button>
            )}
          </div>
        </div>

        {liveClassifying ? (
          <p className="text-gray-500 text-sm">
            Classifying in progress — list paused to save bandwidth. It will
            re-load when classification finishes.
          </p>
        ) : listStatus === "LoadingFirstPage" ? (
          <p className="text-gray-500 text-sm">Loading...</p>
        ) : emails.length === 0 ? (
          <p className="text-gray-500 text-sm">No emails in this view.</p>
        ) : (
          <>
            <ul className="divide-y divide-gray-200 border-y border-gray-200">
              {emails.map((email) => {
                const isArchive = email.classification === "archive";
                const isSent = email.replyStatus === "sent";
                const fade = isArchive || isSent;
                return (
                  <li key={email._id}>
                    <Link
                      href={`/email/${email._id}`}
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
                            {email.fromAddress}
                          </span>
                        </div>
                        <span className="text-xs text-gray-500 shrink-0">
                          {formatEmailTime(email.receivedAt)}
                        </span>
                      </div>
                      <div className="text-sm font-medium mt-0.5 truncate">
                        {email.subject || "(no subject)"}
                      </div>
                      <div className="text-sm text-gray-600 mt-0.5 line-clamp-1">
                        {email.snippet}
                      </div>
                      {email.classificationReason && (
                        <div className="text-xs text-gray-500 mt-1 italic">
                          {email.classificationReason}
                        </div>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
            {listStatus === "CanLoadMore" && (
              <div className="mt-3 flex justify-center">
                <button
                  onClick={() => loadMore(PAGE_SIZE)}
                  className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50"
                >
                  Load more
                </button>
              </div>
            )}
            {listStatus === "LoadingMore" && (
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
