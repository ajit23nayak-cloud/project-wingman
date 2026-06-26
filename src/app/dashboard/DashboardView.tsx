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

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useUser, UserButton } from "@clerk/nextjs";
import { SWRConfig } from "swr";
import { HelpMeThinkModal } from "@/app/_components/HelpMeThinkModal";
import { CalendarTodayView } from "./CalendarTodayView";
import { CadenceFlagsView } from "./CadenceFlagsView";
import { DecisionsPostmortemDueView } from "./DecisionsPostmortemDueView";
import { OKRTrackerView } from "./OKRTrackerView";
import { FeedbackButton } from "@/components/feedback/FeedbackButton";
import { FeedbackPopover } from "@/components/feedback/FeedbackPopover";
import { FeedbackSidebar } from "@/components/feedback/FeedbackSidebar";
import {
  DashboardRow,
  DashboardSection,
  DashboardSectionHeader,
  DashboardRowList,
  formatRelativeAge,
  dotForClassification,
  buildSlackChannelLink,
  SECTION_ACCENTS,
} from "./_primitives";
import { EmailSlidePanel } from "@/components/dashboard/EmailSlidePanel";
import { EngagementStreakBadge } from "@/components/dashboard/EngagementStreakBadge";
import {
  useMe,
  useCounts,
  useEmails,
  useTriggerIngest,
  useDraftCount,
  useStreak,
  useSnooze,
  useNudges,
  useEscalationCount7d,
  useSlackWorkspace,
  useSlackMessages,
  useNotionIntegration,
  useNotionPages,
  markNudgeWidgetSeen,
  type Counts,
  type FeedbackSourceTable,
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
  all: "All caught up — no emails to triage right now. Enjoy the breather.",
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

// Commit 14 Bug 1 fix: wrap the dashboard in an SWRConfig that turns off
// focus-triggered revalidation (the primary cause of the "section flicker"
// Ajit reported on 2026-06-26 — moving the mouse to another window and back
// fired N parallel refetches across the 7 sections), keeps previous data
// during background refetches (no skeleton flash), and dedupes burst
// revalidations within a 60s window. Scope is the dashboard only — other
// surfaces (e.g. /settings, /email/[id]) keep SWR defaults.
//
// Per Tab 2's retrospective rule proposal (log line 6680): "For any new
// dashboard section with SWR-backed data, the spec must explicitly set
// `refreshInterval` (default 0 = manual) + `keepPreviousData: true` +
// `revalidateOnFocus: false`." Wrapping at the page boundary is the
// minimum-blast-radius way to apply that rule retroactively.
export function DashboardView() {
  return (
    <SWRConfig
      value={{
        revalidateOnFocus: false,
        keepPreviousData: true,
        dedupingInterval: 60000,
      }}
    >
      <DashboardViewInner />
    </SWRConfig>
  );
}

function DashboardViewInner() {
  const router = useRouter();
  const { user: clerkUser, isLoaded, isSignedIn } = useUser();
  useEffect(() => {
    if (isLoaded && !isSignedIn) router.replace("/");
  }, [isLoaded, isSignedIn, router]);

  const snooze = useSnooze();
  const [filter, setFilter] = useState<FilterValue>("all");
  const [helpModalOpen, setHelpModalOpen] = useState(false);
  const [openEmailId, setOpenEmailId] = useState<string | null>(null);

  // Commit 12 feedback widget state. `sidebarOpen` controls the slide-in
  // FeedbackSidebar; `popoverState` is the singleton popover (null = closed,
  // object = open and anchored to a specific row). Only one popover can be
  // open at a time across the whole dashboard.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [popoverState, setPopoverState] = useState<{
    anchorEl: HTMLElement | null;
    initialTitle: string;
    sourceTable: FeedbackSourceTable | null;
    sourceId: string | null;
    dashboardSection: string | null;
  } | null>(null);

  const openCommentForRow = useCallback(
    (
      sourceTable: FeedbackSourceTable,
      sourceId: string,
      dashboardSection: string,
      anchorEl: HTMLElement,
      title: string,
    ) => {
      setPopoverState({
        anchorEl,
        initialTitle: title,
        sourceTable,
        sourceId,
        dashboardSection,
      });
    },
    [],
  );

  // Cmd+Shift+R / Ctrl+Shift+R toggles the review-notes sidebar. NOTE:
  // Cmd+Shift+R is the browser's "hard reload" shortcut, so preventDefault
  // is critical — otherwise the keybind blasts the page reload instead.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "r"
      ) {
        e.preventDefault();
        setSidebarOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
  // Commit 14 Bug 4: visible feedback for manual refresh. The handler is
  // wired correctly (and was wired correctly before this commit too); the
  // perceived "nothing happens" was a no-toast / sub-second-spinner UX bug.
  // refreshToast stays visible for 3s after a successful manual sync.
  const [refreshToast, setRefreshToast] = useState<string | null>(null);
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
    setRefreshToast(null);
    // Minimum visible spinner duration so manual clicks always feel like
    // something happened. Tied to Commit 14 Bug 4: when there are no new
    // emails to fetch the sync returns in ~200ms and the user sees nothing.
    const startedAt = Date.now();
    const MIN_VISIBLE_MS = 600;
    try {
      const res = await triggerIngest();
      const elapsed = Date.now() - startedAt;
      if (elapsed < MIN_VISIBLE_MS) {
        await new Promise((r) => setTimeout(r, MIN_VISIBLE_MS - elapsed));
      }
      if (!res.ok && res.error) {
        setIngestError(ERROR_MESSAGES[res.error] ?? `Error: ${res.error}`);
      } else if (res.ok) {
        if (isAuto) {
          setFirstIngestCount(res.ingested ?? 0);
        } else {
          // Manual refresh — show a toast so the user knows it worked even
          // when zero new emails arrived.
          const n = res.ingested ?? 0;
          setRefreshToast(
            n > 0
              ? `Synced — ${n} new email${n === 1 ? "" : "s"}.`
              : "Already up to date.",
          );
          window.setTimeout(() => setRefreshToast(null), 3000);
        }
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
        <h1 className="cred-ui-lower text-xl font-medium tracking-[-0.01em] text-[var(--cred-text-primary)]">
          project wingman
        </h1>
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
                className="cred-ui-lower rounded-[4px] border border-[var(--cred-border)] bg-[var(--cred-card-bg)] px-3 py-1.5 text-[13px] font-medium tracking-[0.01em] text-[var(--cred-text-primary)] hover:bg-[var(--cred-border-soft)]/40"
              >
                help me think
              </button>
            )}
          <Link
            href="/daily"
            className="cred-ui-lower rounded-[4px] border border-[var(--cred-border)] bg-[var(--cred-card-bg)] px-3 py-1.5 text-[13px] font-medium tracking-[0.01em] text-[var(--cred-text-primary)] hover:bg-[var(--cred-border-soft)]/40"
          >
            sharpen the day
            {streak && streak.streakDays > 0 && (
              <span className="ml-1.5 text-[11px] tabular-nums text-[var(--cred-text-meta)]">
                · {streak.streakDays}d
              </span>
            )}
          </Link>
          <button
            onClick={() => runIngest(false)}
            disabled={isIngesting}
            className="cred-ui-lower rounded-[4px] border border-[var(--cred-border)] bg-[var(--cred-card-bg)] px-3 py-1.5 text-[13px] font-medium tracking-[0.01em] text-[var(--cred-text-primary)] hover:bg-[var(--cred-border-soft)]/40 disabled:opacity-50"
          >
            {isIngesting ? "refreshing..." : "refresh inbox"}
          </button>
          <EngagementStreakBadge />
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

      {/* Welcome (Commit 15): Cred + Newspaper treatment. Greeting body
          lowercase per hybrid rule, founder name keeps original casing.
          Stat cards are pastel-gradient hero cards (peach + mint), 44px
          light-weight tabular numerals. Classify-all sits below with explicit
          mb-8 (carried from Commit 14 Bug 3). */}
      <section className="max-w-4xl mx-auto mt-8">
        <h2 className="text-[36px] font-light leading-tight tracking-[-0.035em] text-[var(--cred-text-primary)]">
          <span className="cred-ui-lower">welcome, </span>
          <span>{firstName}</span>
          <span className="cred-ui-lower">.</span>
        </h2>

        {isIngesting && firstIngestCount === null && (
          <div className="mt-4 flex items-center gap-3">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--cred-border)] border-t-[var(--cred-text-secondary)]" />
            <div>
              <p className="text-[13.5px] text-[var(--cred-text-secondary)]">
                Reading your last 30 days of email…
              </p>
              <p className="cred-ui-lower mt-0.5 text-[12px] text-[var(--cred-text-meta)]">
                usually takes 30–90 seconds.
              </p>
            </div>
          </div>
        )}

        {firstIngestCount !== null && !isIngesting && (
          <p className="mt-4 text-[13.5px] text-[var(--cred-text-secondary)]">
            Found {firstIngestCount} emails from the last 30 days.
          </p>
        )}

        {ingestError && (
          <p className="mt-3 text-[13px] text-[var(--chip-red-fg)]">{ingestError}</p>
        )}

        {(meError || countsError) && (
          <p className="mt-3 text-[13px] text-[var(--chip-red-fg)]">Could not load. Refresh.</p>
        )}

        {refreshToast && (
          <p className="mt-3 text-[13px] text-[var(--chip-green-fg)]">{refreshToast}</p>
        )}

        {/* Pastel-gradient stat hero cards. Labels stay UPPERCASE letter-
            spaced — these are tracked micro-labels, not UI text in the
            lowercase rule's scope. Values use tabular-nums for digit
            alignment across the two cards. */}
        <div className="mt-6 grid grid-cols-2 gap-4">
          <div
            className="flex min-h-[120px] flex-col justify-between rounded-[10px] p-6"
            style={{ background: "var(--cred-grad-peach)" }}
          >
            <span className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-[#6b4423] opacity-80">
              emails ingested
            </span>
            <span className="text-[44px] font-light leading-none tracking-[-0.04em] tabular-nums text-[var(--cred-text-primary)]">
              {counts?.total ?? "—"}
            </span>
          </div>
          <div
            className="flex min-h-[120px] flex-col justify-between rounded-[10px] p-6"
            style={{ background: "var(--cred-grad-mint)" }}
          >
            <span className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-[#2b6a40] opacity-80">
              last sync
            </span>
            <span className="text-[44px] font-light leading-none tracking-[-0.04em] tabular-nums text-[var(--cred-text-primary)]">
              {formatRelativeTime(me?.lastIngestedAt)}
            </span>
          </div>
        </div>

        <div className="mt-6 mb-8">
          <button
            disabled
            title="Available next session"
            className="cred-ui-lower rounded-[4px] border border-[var(--cred-border)] bg-[var(--cred-card-bg)] px-3 py-1.5 text-[13px] font-medium tracking-[0.01em] text-[var(--cred-text-primary)] hover:bg-[var(--cred-border-soft)]/40 disabled:opacity-50"
          >
            classify all
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
        <DashboardSection accentColor={SECTION_ACCENTS.alerts}>
          <DashboardSectionHeader
            title="alerts"
            count={null}
            chipColor={showEscalationBanner ? "red" : "amber"}
          />
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
                sourceTable="mh_banner"
                sourceId="assessment"
                onCommentClick={(anchorEl, title) =>
                  openCommentForRow(
                    "mh_banner",
                    "assessment",
                    "alerts",
                    anchorEl,
                    title,
                  )
                }
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
                sourceTable="mh_banner"
                sourceId="onboarding"
                onCommentClick={(anchorEl, title) =>
                  openCommentForRow(
                    "mh_banner",
                    "onboarding",
                    "alerts",
                    anchorEl,
                    title,
                  )
                }
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
                sourceTable="mh_banner"
                sourceId="nudge"
                onCommentClick={(anchorEl, title) =>
                  openCommentForRow(
                    "mh_banner",
                    "nudge",
                    "alerts",
                    anchorEl,
                    title,
                  )
                }
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
                sourceTable="mh_banner"
                sourceId="escalation"
                onCommentClick={(anchorEl, title) =>
                  openCommentForRow(
                    "mh_banner",
                    "escalation",
                    "alerts",
                    anchorEl,
                    title,
                  )
                }
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
      <CadenceFlagsView onCommentClick={openCommentForRow} />
      <DecisionsPostmortemDueView onCommentClick={openCommentForRow} />
      <OKRTrackerView onCommentClick={openCommentForRow} />
      <CalendarTodayView onCommentClick={openCommentForRow} />

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
        <DashboardSection accentColor={SECTION_ACCENTS.slack}>
          <DashboardSectionHeader
            title="slack"
            count={`${slackMessages.length} dm${slackMessages.length === 1 ? "" : "s"}`}
            chipColor="grey"
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
                sourceTable="slack_messages"
                sourceId={m.id}
                onCommentClick={(anchorEl, title) =>
                  openCommentForRow(
                    "slack_messages",
                    m.id,
                    "slack",
                    anchorEl,
                    title,
                  )
                }
                actions={[
                  {
                    kind: "snooze",
                    onPickSnoozedUntil: (d) => {
                      void snooze({
                        source_table: "slack_messages",
                        source_id: m.id,
                        snoozed_until: d.toISOString(),
                      });
                    },
                  },
                ]}
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
        <DashboardSection accentColor={SECTION_ACCENTS.notion}>
          <DashboardSectionHeader
            title="notion"
            count={`${notionPages.length} page${notionPages.length === 1 ? "" : "s"}`}
            chipColor="grey"
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
                  sourceTable="notion_pages"
                  sourceId={p.id}
                  onCommentClick={(anchorEl, title) =>
                    openCommentForRow(
                      "notion_pages",
                      p.id,
                      "notion",
                      anchorEl,
                      title,
                    )
                  }
                />
              ))}
          </DashboardRowList>
        </DashboardSection>
      )}

      {/* Email section — LAST per Lock 1. Filter tabs + pending notice +
          observations stay attached. Rows use DashboardRow; email opens
          in new tab per Lock 2 to preserve dashboard context + draft-reply
          flow. */}
      <DashboardSection accentColor={SECTION_ACCENTS.email}>
        <DashboardSectionHeader
          title="email"
          count={`${counts?.total ?? 0}`}
          chipColor={(counts?.urgent ?? 0) > 0 ? "red" : "grey"}
        />

        <div className="flex items-center justify-between mb-3 mt-3 flex-wrap gap-3 px-4">
          <div className="flex items-center gap-2 flex-wrap">
            {FILTERS.map((f) => {
              const c = countFor(counts, f.value);
              const isActive = filter === f.value;
              return (
                <button
                  key={f.value}
                  onClick={() => setFilter(f.value)}
                  className={`cred-ui-lower text-[11px] tracking-[0.02em] px-2.5 py-1 rounded-[3px] border transition ${
                    isActive
                      ? "border-[var(--cred-text-primary)] bg-[var(--cred-text-primary)] text-[var(--cred-card-bg)]"
                      : "border-[var(--cred-border)] bg-[var(--cred-card-bg)] text-[var(--cred-text-secondary)] hover:border-[var(--cred-text-meta)]"
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
          <p className="cred-ui-lower mb-3 px-4 text-[13px] text-[var(--cred-text-secondary)]">
            classifying your inbox… ({counts.pending} remaining)
          </p>
        )}

        {nudges.observations.length > 0 && (
          <div className="mb-3 space-y-1 px-4">
            {nudges.observations.map((obs, i) => (
              <Link
                key={i}
                href={obs.href}
                className="block text-[13px] italic text-[var(--cred-text-secondary)] hover:text-[var(--cred-text-primary)] hover:underline"
              >
                {obs.text}{" "}
                <span className="not-italic text-[11px] text-[var(--cred-text-meta)]">→</span>
              </Link>
            ))}
          </div>
        )}

        {emailsHook.error ? (
          <p className="mt-3 px-4 text-[13px] text-[var(--chip-red-fg)]">
            Could not load. Refresh.
          </p>
        ) : loadingFirstPage ? (
          <p className="cred-ui-lower px-4 py-2 text-[13px] text-[var(--cred-text-meta)]">loading…</p>
        ) : emails.length === 0 ? (
          <p className="px-4 py-2 text-[13px] text-[var(--cred-text-secondary)]">
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
                    onClick={() => setOpenEmailId(email.id)}
                    fade={fade}
                    sourceTable="emails"
                    sourceId={email.id}
                    onCommentClick={(anchorEl, title) =>
                      openCommentForRow(
                        "emails",
                        email.id,
                        "emails",
                        anchorEl,
                        title,
                      )
                    }
                    actions={[
                      {
                        kind: "snooze",
                        onPickSnoozedUntil: (d) => {
                          void snooze({
                            source_table: "emails",
                            source_id: email.id,
                            snoozed_until: d.toISOString(),
                          });
                        },
                      },
                    ]}
                  />
                );
              })}
            </DashboardRowList>
            {!reachedEnd && !loadingMore && (
              <div className="mt-3 flex justify-center pb-3">
                <button
                  onClick={() => emailsHook.setSize((s) => s + 1)}
                  className="cred-ui-lower rounded-[4px] border border-[var(--cred-border)] bg-[var(--cred-card-bg)] px-3 py-1.5 text-[13px] font-medium tracking-[0.01em] text-[var(--cred-text-primary)] hover:bg-[var(--cred-border-soft)]/40"
                >
                  load more
                </button>
              </div>
            )}
            {loadingMore && (
              <p className="cred-ui-lower mt-3 pb-3 text-center text-[11px] text-[var(--cred-text-meta)]">
                loading more…
              </p>
            )}
          </>
        )}
      </DashboardSection>

      <HelpMeThinkModal
        open={helpModalOpen}
        onClose={() => setHelpModalOpen(false)}
      />

      {/* Commit 12 in-dashboard feedback widget. FeedbackButton is the
          floating "+" CTA (bottom-right). FeedbackSidebar is the slide-in
          review panel (opened via the button's "View all notes", a row's
          popover footer, or Cmd+Shift+R). FeedbackPopover is the singleton
          authoring popover, anchored to whichever surface fired it. */}
      <FeedbackButton onOpenSidebar={() => setSidebarOpen(true)} />
      <FeedbackSidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      {popoverState && (
        <FeedbackPopover
          isOpen={true}
          onClose={() => setPopoverState(null)}
          anchorEl={popoverState.anchorEl}
          initialTitle={popoverState.initialTitle}
          sourceTable={popoverState.sourceTable}
          sourceId={popoverState.sourceId}
          dashboardSection={popoverState.dashboardSection}
          onViewAll={() => {
            setPopoverState(null);
            setSidebarOpen(true);
          }}
        />
      )}

      {/* Mega-commit A P0.3: clicking an email row opens a right-edge slide
          panel instead of a new browser tab. /email/[id] route still works
          for direct URL access; both render the same EmailDetailBody. */}
      <EmailSlidePanel
        emailId={openEmailId}
        onClose={() => setOpenEmailId(null)}
      />
    </main>
  );
}
