"use client";

// Dashboard, Supabase/SWR variant. Replaces the Convex live-query version.
// Data flow: useMe loads first (gates the rest), useCounts + useEmails query
// Postgres directly via the Clerk JWT, useTriggerIngest fires the server
// ingest route then invalidates the keys above.
//
// Superhuman-inspired redesign (2026-06-18): all list surfaces (MH banner
// stack, Slack DMs, Notion Pages, Email list) use the shared DashboardRow
// pattern from ./_primitives. Section order per Lock 1: Cadence → Decisions
// → OKR → Calendar → Slack → Notion → Email (last). Email rows open in new
// tab per Lock 2.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useUser, UserButton } from "@clerk/nextjs";
import { HelpMeThinkModal } from "@/app/_components/HelpMeThinkModal";
import { CalendarTodayView } from "./CalendarTodayView";
import { CadenceFlagsView } from "./CadenceFlagsView";
import { DecisionsPostmortemDueView } from "./DecisionsPostmortemDueView";
import { OKRTrackerView } from "./OKRTrackerView";
import {
  DashboardRow,
  DashboardSection,
  DashboardSectionHeader,
  DashboardRowList,
  formatRelativeAge,
  dotForClassification,
  buildSlackChannelLink,
} from "./_primitives";
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

  // MH banner-stack visibility flags — used to decide whether to render the
  // "alerts" section at all. If all 4 banners are hidden, section is skipped.
  const showEscalationBanner =
    escalationCount7d !== undefined && escalationCount7d >= 3;
  const showAnyMhBanner =
    showAssessmentBanner ||
    showOnboardingBanner ||
    !!nudges.widget ||
    showEscalationBanner;

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

      {/* Gmail reauth — global error banner, stays at top of page (visual
          presentation untouched per spec; row pattern doesn't apply to
          descriptive-CTA banners). */}
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

      {/* Welcome card — reduced visual weight vs the original h2/grid layout.
          Stays at the top per the redesign brief: name greeting + ingest
          progress + counts + Classify-all. NOT a DashboardSection — it's the
          opening "hello" card, not a list surface. */}
      <section className="max-w-4xl mx-auto mt-6">
        <h2 className="text-lg font-semibold">Welcome, {firstName}.</h2>

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
          <p className="mt-3 text-gray-700 text-sm">
            Found {firstIngestCount} emails from the last 30 days.
          </p>
        )}

        {ingestError && (
          <p className="mt-3 text-sm text-red-600">{ingestError}</p>
        )}

        {(meError || countsError) && (
          <p className="mt-3 text-sm text-red-600">Could not load. Refresh.</p>
        )}

        <div className="mt-4 grid grid-cols-2 gap-3 max-w-md">
          <div className="rounded-lg border border-gray-200 p-3">
            <div className="text-[11px] text-gray-500 uppercase tracking-wide">
              Emails ingested
            </div>
            <div className="text-lg font-semibold mt-0.5">
              {counts?.total ?? "—"}
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 p-3">
            <div className="text-[11px] text-gray-500 uppercase tracking-wide">
              Last sync
            </div>
            <div className="text-lg font-semibold mt-0.5">
              {formatRelativeTime(me?.lastIngestedAt)}
            </div>
          </div>
        </div>

        <div className="mt-4">
          <button
            disabled
            title="Available next session"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
          >
            Classify all
          </button>
        </div>
      </section>

      {/* MH banner stack — Lock 4: the 4 card banners (Assessment, Onboarding,
          Nudge widget, Escalation) repaint to the row pattern. Section title
          is "alerts" — picked over "today" because it covers the heterogenous
          mix (action prompts + safety + nudges) better than a time-of-day
          framing. Section hides entirely when no banner is visible. Crisis
          resources list still renders below the escalation row to preserve
          discoverability per Lock 4 safety caveat. */}
      {showAnyMhBanner && (
        <DashboardSection>
          <DashboardSectionHeader title="alerts" count={null} />
          <DashboardRowList>
            {showAssessmentBanner && (
              <DashboardRow
                dot="amber"
                dotLabel="assessment pending"
                time="now"
                title="Personalize Wingman in 90 seconds"
                badge="mh"
                hint="start"
                href="/assessment"
                external={false}
              />
            )}
            {showOnboardingBanner && (
              <DashboardRow
                dot="amber"
                dotLabel="onboarding nudge"
                time="now"
                title="Inbox classified. Try generating your first draft reply."
                badge="nudge"
                hint="dismiss"
                onClick={handleDismissBanner}
              />
            )}
            {nudges.widget && (
              <DashboardRow
                dot="grey"
                dotLabel="nudge"
                time="now"
                title={nudges.widget.title}
                badge="nudge"
                hint=""
              />
            )}
            {showEscalationBanner && (
              <DashboardRow
                dot="red"
                dotLabel="heavy weeks signal"
                time="now"
                title="Wingman noticed you've been carrying heavy weeks"
                badge="mh"
                hint=""
              />
            )}
          </DashboardRowList>
          {showEscalationBanner && (
            <p className="px-2 mt-1 text-[11px] text-gray-500">
              India: iCall 9152987821 · Vandrevala 1860-2662-345 · US: 988 ·
              UK: Samaritans 116 123 ·{" "}
              <a
                href="https://www.iasp.info/resources/Crisis_Centres"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                IASP directory
              </a>
            </p>
          )}
        </DashboardSection>
      )}

      {/* Section order from spec Lock 1 (08:55 UTC):
          MH alerts → Cadence → Decisions → OKR → Calendar → Slack → Notion →
          Email (LAST). Strategic surfaces above tactical so we don't
          re-trigger inbox-zero anxiety. */}
      <CadenceFlagsView />
      <DecisionsPostmortemDueView />
      <OKRTrackerView />
      <CalendarTodayView />

      {/* Connect Slack banner — sits right above the Slack DMs section so it
          reads as per-section context, not a global CTA. Hidden once a
          workspace is connected; the Slack DMs section below takes over. */}
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

      {/* Slack DMs section — row pattern via DashboardRow. Hidden when no
          workspace connected (banner above covers CTA) or when no messages. */}
      {slackWorkspace && slackMessages && slackMessages.length > 0 && (
        <DashboardSection>
          <DashboardSectionHeader
            title="slack"
            count={`${slackMessages.length} dm${slackMessages.length === 1 ? "" : "s"}`}
          />
          <DashboardRowList>
            {slackMessages.map((m) => (
              <DashboardRow
                key={m.id}
                dot={dotForClassification(m.classification)}
                dotLabel={`urgency: ${m.classification}`}
                time={formatRelativeAge(m.received_at)}
                title={`${m.sender_name ?? m.sender_id}: ${m.text.slice(0, 60)}`}
                badge="slack"
                hint="view"
                href={buildSlackChannelLink(
                  slackWorkspace.team_id,
                  m.channel_id,
                )}
                external={true}
              />
            ))}
          </DashboardRowList>
        </DashboardSection>
      )}

      {/* Connect Notion banner — sits right above the Notion Pages section.
          Same per-section context pattern as Connect Slack. Originally
          gated behind slackWorkspace presence to avoid double-banner stack;
          now it's per-section so the gate is dropped — banner shows whenever
          Notion isn't connected. */}
      {!notionIntegrationLoading && !notionIntegration && (
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

      {/* Notion Pages section — row pattern via DashboardRow. Each row links
          out to the original page in Notion (external new tab per Lock 3). */}
      {notionIntegration && notionPages && notionPages.length > 0 && (
        <DashboardSection>
          <DashboardSectionHeader
            title="notion"
            count={`${notionPages.length} page${notionPages.length === 1 ? "" : "s"}`}
          />
          <DashboardRowList>
            {notionPages
              .filter((p) => p.url)
              .map((p) => (
                <DashboardRow
                  key={p.id}
                  dot={dotForClassification(p.classification)}
                  dotLabel={`urgency: ${p.classification}`}
                  time={formatRelativeAge(p.received_at)}
                  title={p.title || "(untitled page)"}
                  badge="notion"
                  hint="open"
                  href={p.url ?? undefined}
                  external={true}
                />
              ))}
          </DashboardRowList>
        </DashboardSection>
      )}

      {/* Email section — LAST per Lock 1. Filter tabs + pending notice +
          observations stay attached. Rows use DashboardRow; email opens
          in new tab per Lock 2 to preserve dashboard context + draft-reply
          flow. */}
      <DashboardSection>
        <DashboardSectionHeader
          title="email"
          count={`${counts?.total ?? 0}`}
        />

        <div className="flex items-center justify-between mb-3 flex-wrap gap-3 px-2">
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
          <p className="mb-3 px-2 text-sm text-gray-600">
            Classifying your inbox… ({counts.pending} remaining)
          </p>
        )}

        {nudges.observations.length > 0 && (
          <div className="mb-3 space-y-1 px-2">
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
          <p className="mt-3 px-2 text-sm text-red-600">
            Could not load. Refresh.
          </p>
        ) : loadingFirstPage ? (
          <p className="px-2 text-gray-500 text-sm">Loading...</p>
        ) : emails.length === 0 ? (
          <p className="px-2 text-gray-500 text-sm">
            {EMPTY_BUCKET_COPY[filter]}
          </p>
        ) : (
          <>
            <DashboardRowList>
              {emails.map((email) => {
                const draft = Array.isArray(email.drafts)
                  ? email.drafts[0]
                  : email.drafts;
                const fade =
                  email.classification === "archive" ||
                  draft?.status === "sent";
                return (
                  <DashboardRow
                    key={email.id}
                    dot={dotForClassification(email.classification)}
                    dotLabel={`urgency: ${email.classification ?? "unknown"}`}
                    time={formatRelativeAge(email.received_at)}
                    title={email.subject || "(no subject)"}
                    badge="gmail"
                    hint="reply"
                    href={`/email/${email.id}`}
                    external={true}
                    fade={fade}
                  />
                );
              })}
            </DashboardRowList>
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
      </DashboardSection>

      <HelpMeThinkModal
        open={helpModalOpen}
        onClose={() => setHelpModalOpen(false)}
      />
    </main>
  );
}
