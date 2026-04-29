"use client";

import { useEffect, useRef, useState } from "react";
import { useUser, UserButton } from "@clerk/nextjs";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";

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
  token_fetch_failed: "Could not refresh your Google token. Try signing in again.",
  gmail_fetch_failed: "Gmail is temporarily unavailable. Please try refreshing.",
};

export function DashboardView() {
  const { user: clerkUser } = useUser();
  const convexUser = useQuery(api.users.currentUser);
  const emails = useQuery(api.inbox.listRecent, { limit: 20 });
  const totalCount = useQuery(api.inbox.countForUser);
  const ingestEmails = useAction(api.emails.ingestEmails);
  const testGemini = useAction(api.llm.testGemini);

  const [isIngesting, setIsIngesting] = useState(false);
  const [firstIngestCount, setFirstIngestCount] = useState<number | null>(null);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [aiTestResult, setAiTestResult] = useState<string | null>(null);
  const [aiTesting, setAiTesting] = useState(false);
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
        err instanceof Error ? err.message : "Unexpected error during ingestion.",
      );
    } finally {
      setIsIngesting(false);
    }
  };

  useEffect(() => {
    if (convexUser === undefined) return;
    if (autoTriggeredRef.current) return;
    if (convexUser === null || !convexUser.lastIngestedAt) {
      autoTriggeredRef.current = true;
      runIngest(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convexUser]);

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

  const firstName = clerkUser?.firstName ?? clerkUser?.fullName ?? "there";

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
        <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-3">
          Recent emails
        </h3>
        {emails === undefined ? (
          <p className="text-gray-500 text-sm">Loading...</p>
        ) : emails.length === 0 ? (
          <p className="text-gray-500 text-sm">No emails yet.</p>
        ) : (
          <ul className="divide-y divide-gray-200 border-y border-gray-200">
            {emails.map((email) => (
              <li key={email._id} className="py-3">
                <div className="flex justify-between items-baseline gap-3">
                  <span className="font-medium text-sm truncate flex-1">
                    {email.fromAddress}
                  </span>
                  <span className="text-xs text-gray-500 shrink-0">
                    {formatEmailTime(email.receivedAt)}
                  </span>
                </div>
                <div className="text-sm font-medium mt-0.5 truncate">
                  {email.subject || "(no subject)"}
                </div>
                <div className="text-sm text-gray-600 mt-0.5 line-clamp-1">
                  {email.snippet.slice(0, 100)}
                  {email.snippet.length > 100 ? "..." : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
