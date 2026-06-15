"use client";

// Dashboard, Supabase/SWR variant. Replaces the Convex live-query version.
// Data flow: useMe loads first (gates the rest), useCounts + useEmails query
// Postgres directly via the Clerk JWT, useTriggerIngest fires the server
// ingest route then invalidates the keys above.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useUser, UserButton } from "@clerk/nextjs";
import { HelpMeThinkModal } from "@/app/_components/HelpMeThinkModal";
import { CalendarTodayView } from "./CalendarTodayView";
import { CadenceFlagsView } from "./CadenceFlagsView";
import { DecisionsPostmortemDueView } from "./DecisionsPostmortemDueView";
import {
  useMe,
  useCounts,
  useEmails,
  useTriggerIngest,
  useDraftCount,
  useStreak,
  useNudges,
  useEscalationCount7d,
  useSlackWorkspace,
  useSlackMessages,
  useNotionIntegration,
  useNotionPages,
  markNudgeWidgetSeen,
  type Counts,
  type FilterValue,
  type EmailRow,
  type SlackMessageRow,
  type NotionPageRow,
} from "@/lib/supabase/hooks";

const ONBOARDING_DISMISS_KEY = "wingman_onboarding_dismissed";

// Small inline icon for the Settings link in the user-avatar dropdown.
// Clerk's UserButton.Link requires a labelIcon prop; reusing a simple SVG
// rather than pulling in an icon library for one glyph.
function SettingsIcon() {
  return (
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
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

// Per-filter copy for the empty list state. "No emails in this view" was the
// pre-onboarding-polish text — these replacements give each filter a
// reassuring, specific message per sprint-strategy.md section 2 friction
// point "Empty bucket messaging when Urgent = 0."
const EMPTY_BUCKET_COPY: Record<FilterValue, string> = {
  all: "No emails ingested yet — try Refresh inbox.",
  urgent: "0 urgent emails right now. Looking calm — enjoy the breather.",
  important: "Nothing important needs your attention right now.",
  fyi: "No FYI items in view.",
  archive: "No archived emails yet.",
};

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

// Inline Slack mark — official colorway. Copied from SettingsView's SlackIcon
// so we don't take a cross-component import dependency for one SVG.
function SlackIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M5 14.5a2.5 2.5 0 1 1 2.5-2.5v2.5H5z" fill="#36C5F0" />
      <path
        d="M6.25 14.5a2.5 2.5 0 0 1 5 0v6.25a2.5 2.5 0 0 1-5 0V14.5z"
        fill="#2EB67D"
      />
      <path d="M9.5 5a2.5 2.5 0 1 1 2.5 2.5H9.5V5z" fill="#ECB22E" />
      <path
        d="M9.5 6.25a2.5 2.5 0 0 1 0 5H3.25a2.5 2.5 0 0 1 0-5H9.5z"
        fill="#E01E5A"
      />
      <path d="M19 9.5a2.5 2.5 0 1 1-2.5 2.5V9.5H19z" fill="#36C5F0" />
      <path
        d="M17.75 9.5a2.5 2.5 0 0 1-5 0V3.25a2.5 2.5 0 0 1 5 0V9.5z"
        fill="#2EB67D"
      />
      <path d="M14.5 19a2.5 2.5 0 1 1-2.5-2.5h2.5V19z" fill="#ECB22E" />
      <path
        d="M14.5 17.75a2.5 2.5 0 0 1 0-5h6.25a2.5 2.5 0 0 1 0 5H14.5z"
        fill="#E01E5A"
      />
    </svg>
  );
}

// Slack message row. Matches the email row's visual rhythm — same border,
// same padding, same classification badge color scheme. Prefixed with the
// Slack icon instead of the (implicit) email source.
function SlackMessageRowView({ message }: { message: SlackMessageRow }) {
  const sender = message.sender_name ?? message.sender_id;
  const badgeClass = BADGE_STYLES[message.classification];
  return (
    <div className="flex items-center gap-3 rounded-md border border-gray-100 bg-white px-3 py-2 hover:border-gray-300">
      <SlackIcon className="h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-gray-900">
            {sender}
          </span>
          <span
            className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase ${badgeClass}`}
          >
            {message.classification}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-gray-600">{message.text}</p>
      </div>
      <span className="shrink-0 text-xs text-gray-500">
        {formatEmailTime(message.received_at)}
      </span>
    </div>
  );
}

// Simple page-icon glyph for Notion rows. Single solid color (not the brand
// wordmark) — distinguishable from Slack's rainbow at a glance without
// invoking brand-asset compliance for v0.
function NotionPageIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M5 3h10l4 4v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm9 1.5V8h3.5L14 4.5zM8 11h8v1.5H8V11zm0 3h8v1.5H8V14zm0 3h5v1.5H8V17z" />
    </svg>
  );
}

// Notion page row. Mirrors the SlackMessageRowView aesthetic — same border,
// padding, badge styling. When the page has a non-null url, the whole row is
// a target=_blank anchor so a click opens the page in Notion. When url is
// null (rare; row stored before url was populated), the row is non-clickable
// so the user isn't sent to a broken link.
function NotionPageRowView({ page }: { page: NotionPageRow }) {
  const badgeClass = BADGE_STYLES[page.classification];
  const content = (
    <div className="flex items-center gap-3 rounded-md border border-gray-100 bg-white px-3 py-2 hover:border-gray-300">
      <NotionPageIcon className="h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-gray-900">
            {page.title || "(untitled page)"}
          </span>
          <span
            className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase ${badgeClass}`}
          >
            {page.classification}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-gray-600">{page.snippet}</p>
      </div>
      <span className="shrink-0 text-xs text-gray-500">
        {formatEmailTime(page.received_at)}
      </span>
    </div>
  );
  return page.url ? (
    <a
      href={page.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block"
    >
      {content}
    </a>
  ) : (
    content
  );
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
  const [helpModalOpen, setHelpModalOpen] = useState(false);

  const { data: me, error: meError } = useMe();
  const { data: counts, error: countsError } = useCounts();
  const { data: draftCount } = useDraftCount();
  const { data: streak } = useStreak();
  const { data: escalationCount7d } = useEscalationCount7d();
  const { data: slackWorkspace, isLoading: slackWorkspaceLoading } =
    useSlackWorkspace();
  const { data: slackMessages } = useSlackMessages(filter);
  const { data: notionIntegration, isLoading: notionIntegrationLoading } =
    useNotionIntegration();
  // Pass null filter when no Notion integration exists so the SWR key
  // stays null and the query never fires — avoids wasted bandwidth on
  // users who haven't connected Notion.
  const { data: notionPages } = useNotionPages(notionIntegration ? filter : null);
  const nudges = useNudges();
  const emailsHook = useEmails(filter, PAGE_SIZE);

  const triggerIngest = useTriggerIngest();

  const [isIngesting, setIsIngesting] = useState(false);
  const [firstIngestCount, setFirstIngestCount] = useState<number | null>(null);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const autoTriggeredRef = useRef(false);

  // Onboarding banner state — show if user has generated 0 drafts AND
  // hasn't dismissed via localStorage. Effect reads localStorage on mount
  // to avoid SSR hydration mismatch. Once draftCount > 0, the banner
  // hides naturally (without needing to write the dismiss flag).
  const [bannerDismissed, setBannerDismissed] = useState(true);
  useEffect(() => {
    setBannerDismissed(
      typeof window !== "undefined" &&
        window.localStorage.getItem(ONBOARDING_DISMISS_KEY) === "1",
    );
  }, []);
  const handleDismissBanner = () => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(ONBOARDING_DISMISS_KEY, "1");
    }
    setBannerDismissed(true);
  };
  const showOnboardingBanner =
    !bannerDismissed &&
    draftCount !== undefined &&
    draftCount === 0 &&
    counts !== undefined &&
    counts.total > 0;

  // Assessment-nudge banner. Renders when the founder hasn't taken the MH
  // assessment AND hasn't recently/repeatedly skipped it. Per MH_UI_SPEC.md
  // L173 + Tab 2 16:50 UTC lock: skip count maxes at 2; first skip suppresses
  // the banner for 24h, second skip suppresses permanently (banner gone from
  // dashboard, but /assessment is still navigable directly).
  const SKIP_COOLDOWN_MS = 24 * 60 * 60 * 1000;
  const showAssessmentBanner =
    me !== undefined &&
    me.mhStyle === null &&
    me.mhAssessmentSkipCount < 2 &&
    (me.mhAssessmentSkippedAt === null ||
      Date.now() - new Date(me.mhAssessmentSkippedAt).getTime() >
        SKIP_COOLDOWN_MS);

  // Render-time mark-seen for the contextual nudge widget. Lifted out of
  // useNudges per Tab 2's 01:35 batch instruction — only flag the trigger as
  // "seen today" when the widget actually reaches DOM. Prevents the
  // speculative-seen-write bug class where useNudges returns a widget that
  // never renders (rare but possible during route transitions).
  useEffect(() => {
    if (nudges.widget && nudges.widgetTrigger && me) {
      markNudgeWidgetSeen(me.supabaseUserId, nudges.widgetTrigger);
    }
  }, [nudges.widget, nudges.widgetTrigger, me]);

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
          {/* Help me think — hidden for State B (assessment never engaged).
              State A/C/D get the button. Same precedence as the assessment
              banner: don't surface MH surfaces until the user has either
              taken or explicitly skipped the assessment. */}
          {me &&
            !(me.mhStyle === null && me.mhAssessmentSkipCount === 0) && (
              <button
                type="button"
                onClick={() => setHelpModalOpen(true)}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50"
              >
                Help me think
              </button>
            )}
          <Link
            href="/daily"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50"
          >
            Daily ritual
            {streak && streak.streakDays > 0 && (
              <span className="ml-1.5 text-xs text-gray-500">
                · {streak.streakDays}d
              </span>
            )}
          </Link>
          <button
            onClick={() => runIngest(false)}
            disabled={isIngesting}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
          >
            {isIngesting ? "Refreshing..." : "Refresh inbox"}
          </button>
          <UserButton>
            <UserButton.MenuItems>
              <UserButton.Link
                label="Settings"
                labelIcon={<SettingsIcon />}
                href="/settings"
              />
            </UserButton.MenuItems>
          </UserButton>
        </div>
      </header>

      {/* Section order from top per Tab 2 09:35 UTC architectural lock:
          Cadence flags → Decisions due for postmortem → Today's Calendar →
          banners → email/Slack/Notion. The two CRM sections render ONLY when
          non-empty (silent loading + silent empty per Tab 1 D5). */}
      <CadenceFlagsView />
      <DecisionsPostmortemDueView />

      {/* Today's Calendar — highest time-sensitivity signal for a founder,
          ahead of Gmail-reauth/Slack/Notion banners and ahead of the email list. */}
      <CalendarTodayView />

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

      {/* Connect Slack banner — renders only when workspace data has loaded
          AND no workspace exists. When workspace is present, the Slack DM
          section below takes over. */}
      {!slackWorkspaceLoading && !slackWorkspace && (
        <div className="max-w-4xl mx-auto mt-6 rounded-lg border border-purple-200 bg-purple-50 p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-purple-900">
                Connect Slack
              </p>
              <p className="mt-1 text-xs text-purple-800">
                Pull your 1:1 DMs into Wingman&apos;s classifier alongside your
                inbox.
              </p>
            </div>
            <Link
              href="/settings"
              className="rounded-md bg-purple-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-800 shrink-0"
            >
              Open Settings
            </Link>
          </div>
        </div>
      )}

      {/* Connect Notion banner — LOWER priority than the Slack banner. Only
          shown when Notion is NOT connected AND Slack IS connected, so we
          never stack two "connect something" banners at once. When both
          integrations are missing, the Slack banner above takes precedence;
          the Notion banner appears on the next dashboard visit after Slack
          is connected. */}
      {!notionIntegrationLoading && !notionIntegration && slackWorkspace && (
        <div className="max-w-4xl mx-auto mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-amber-900">
                Connect Notion
              </p>
              <p className="mt-1 text-xs text-amber-800">
                Pull your recent Notion page edits into Wingman&apos;s
                classifier alongside email and Slack.
              </p>
            </div>
            <Link
              href="/settings"
              className="rounded-md bg-amber-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-800 shrink-0"
            >
              Open Settings
            </Link>
          </div>
        </div>
      )}

      <section className="max-w-4xl mx-auto mt-10">
        <h2 className="text-2xl font-semibold">Welcome, {firstName}.</h2>

        {isIngesting && firstIngestCount === null && (
          <div className="mt-3 flex items-center gap-3">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-700" />
            <div>
              <p className="text-gray-700 text-sm">
                Reading your last 30 days of email…
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                Usually takes 30–90 seconds.
              </p>
            </div>
          </div>
        )}

        {firstIngestCount !== null && !isIngesting && (
          <p className="mt-3 text-gray-700">
            Found {firstIngestCount} emails from the last 30 days.
          </p>
        )}

        {showAssessmentBanner && (
          <div className="mt-6 rounded-lg border border-purple-200 bg-purple-50 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold text-purple-900">
                  Personalize Wingman in 90 seconds
                </h3>
                <p className="mt-1 text-sm text-purple-800">
                  Six quick questions so the reflection prompts and nudges
                  match how you actually think.
                </p>
              </div>
              <Link
                href="/assessment"
                className="rounded-md bg-purple-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-800 shrink-0"
              >
                Start
              </Link>
            </div>
          </div>
        )}

        {showOnboardingBanner && (
          <div className="mt-6 rounded-lg border border-blue-200 bg-blue-50 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold text-blue-900">
                  👋 We&apos;ve classified your inbox.
                </h3>
                <p className="mt-1 text-sm text-blue-800">
                  Try generating your first draft reply — click any Urgent or
                  Important email below.
                </p>
              </div>
              <button
                type="button"
                onClick={handleDismissBanner}
                className="text-xs text-blue-700 hover:text-blue-900 underline shrink-0"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {nudges.widget && (
          <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <h3 className="font-semibold text-slate-900">
              {nudges.widget.title}
            </h3>
            <p className="mt-1 text-sm text-slate-700">{nudges.widget.body}</p>
          </div>
        )}

        {/* Proactive safety nudge — fires when user has hit the safety
            boundary 3+ times in the last 7 days. Per Tab 2 01:05 UTC lock,
            this is a gentle reminder that Wingman isn't built for the
            weight they're carrying. No content shared, just the count
            signal. */}
        {escalationCount7d !== undefined && escalationCount7d >= 3 && (
          <div className="mt-6 rounded-lg border border-rose-200 bg-rose-50 p-4">
            <h3 className="font-semibold text-rose-900">
              Wingman noticed you&apos;ve been carrying heavy weeks
            </h3>
            <p className="mt-1 text-sm text-rose-800">
              We&apos;re not built for this kind of support — please consider
              talking to a professional. Crisis resources:
            </p>
            <ul className="mt-2 text-sm text-rose-800 list-disc pl-5 space-y-0.5">
              <li>India: iCall 9152987821, Vandrevala 1860-2662-345</li>
              <li>US: 988 Suicide &amp; Crisis Lifeline</li>
              <li>UK: Samaritans 116 123</li>
              <li>
                Elsewhere:{" "}
                <a
                  href="https://www.iasp.info/resources/Crisis_Centres"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  IASP directory
                </a>
              </li>
            </ul>
          </div>
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

        {nudges.observations.length > 0 && (
          <div className="mb-3 space-y-1">
            {nudges.observations.map((obs, i) => (
              <Link
                key={i}
                href={obs.href}
                className="block text-sm italic text-gray-600 hover:text-gray-900 hover:underline"
              >
                {obs.text}{" "}
                <span className="not-italic text-xs text-gray-500">→</span>
              </Link>
            ))}
          </div>
        )}

        {emailsHook.error ? (
          <p className="mt-3 text-sm text-red-600">Could not load. Refresh.</p>
        ) : loadingFirstPage ? (
          <p className="text-gray-500 text-sm">Loading...</p>
        ) : emails.length === 0 ? (
          <p className="text-gray-500 text-sm">{EMPTY_BUCKET_COPY[filter]}</p>
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
                    <Link
                      href={`/email/${email.id}`}
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
                    </Link>
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

        {/* Slack DM section — separate from the email list, filtered by the
            same activeFilter. v0 limit: 20 most-recent classified messages,
            no pagination. Hidden when no workspace is connected (banner up
            top covers that CTA). */}
        {slackWorkspace && slackMessages && slackMessages.length > 0 && (
          <section className="mt-8">
            <h2 className="text-sm font-semibold text-gray-700 mb-2">
              Slack DMs
            </h2>
            <div className="space-y-1">
              {slackMessages.map((m) => (
                <SlackMessageRowView key={m.id} message={m} />
              ))}
            </div>
          </section>
        )}

        {/* Notion Pages section — sits below Slack DMs, shares the activeFilter.
            v0 limit: 20 most-recent classified pages, no pagination. Hidden
            when no Notion integration is connected (banner above covers CTA).
            Each row links out to the original page in Notion (target=_blank). */}
        {notionIntegration && notionPages && notionPages.length > 0 && (
          <section className="mt-8">
            <h2 className="text-sm font-semibold text-gray-700 mb-2">
              Notion Pages
            </h2>
            <div className="space-y-1">
              {notionPages.map((p) => (
                <NotionPageRowView key={p.id} page={p} />
              ))}
            </div>
          </section>
        )}
      </section>
      <HelpMeThinkModal
        open={helpModalOpen}
        onClose={() => setHelpModalOpen(false)}
      />
    </main>
  );
}
