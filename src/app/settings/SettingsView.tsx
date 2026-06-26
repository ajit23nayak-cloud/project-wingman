"use client";

// Settings page. v0 surface: Privacy → Mental health data only. Future
// sections (notifications, account, integrations) land in this same page
// structure.
//
// Tier picker flow per Tab 2 00:50 UTC locks:
//   Sharp Q1: dedicated /settings page (not modal)
//   Sharp Q2: downgrade cleanup cascade (UPDATE-set-null on mh_sessions,
//             DELETE on mh_correlations)
//   Sharp Q3: type-DOWNGRADE confirmation modal with deletion counts +
//             keep/delete split + red destructive button
//   Flag A: upgrade = direct API call, no confirmation
//   Flag C: explicit Save button (tier selection in radio is draft state)
//   Flag D: cache invalidation post-change (handled in useUpdateStorageTier)
//   Flag E: race acceptance (no tier-stamped writes for v0)

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useSWRConfig } from "swr";
import {
  useMe,
  useSlackWorkspace,
  useNotionIntegration,
  useCalendarCredentials,
  useDisconnectCalendar,
  useDisconnectSlack,
  useDisconnectNotion,
  useStorageTierPreview,
  useUpdateStorageTier,
  type StorageTierPreview,
} from "@/lib/supabase/hooks";

type Tier = 1 | 2 | 3 | 4;

type TierDescriptor = {
  tier: Tier;
  label: string;
  oneLine: string;
  stores: string[];
};

const TIERS: TierDescriptor[] = [
  {
    tier: 1,
    label: "Tier 1 — Minimum",
    oneLine: "Just timestamps and which framework you used. No content, no scores.",
    stores: [
      "Ritual + session timestamps",
      "Framework used per session",
      "Streak counter",
    ],
  },
  {
    tier: 2,
    label: "Tier 2 — Aggregates (default)",
    oneLine: "Numeric and structured scores. No free text.",
    stores: [
      "Everything in Tier 1",
      "Numeric scores (energy, focus, mood, 1-10)",
      "Structured signals (R/Y/G ratings, MIP completion counts)",
      "Nudge engagement (dismissed vs acted)",
    ],
  },
  {
    tier: 3,
    label: "Tier 3 — Text history",
    oneLine: "Your full text — MIPs, thoughts, journal entries, chat transcripts.",
    stores: [
      "Everything in Tier 2",
      "Full text of MIPs and intentions",
      "Stressful thoughts and Katie inquiry responses",
      "OPA decision flows, Help me think chat transcripts",
    ],
  },
  {
    tier: 4,
    label: "Tier 4 — Full correlation engine",
    oneLine:
      "Tier 3 + nightly correlations between MH data and email/calendar patterns.",
    stores: [
      "Everything in Tier 3",
      "Computed correlations (e.g., decision quality on green-energy days)",
      "Insights surface (active after ~30 days of data)",
    ],
  },
];

export function SettingsView() {
  const { data: me, error: meError } = useMe();
  const getPreview = useStorageTierPreview();
  const updateTier = useUpdateStorageTier();

  const currentTier = (me?.mhStorageTier ?? 2) as Tier;
  const [selectedTier, setSelectedTier] = useState<Tier>(currentTier);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Downgrade confirm modal state.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [preview, setPreview] = useState<StorageTierPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [typeConfirm, setTypeConfirm] = useState("");

  // Slack + Notion OAuth callback toast — landing back on
  // /settings?slack_connected=1 (or notion_connected=1) on success, or
  // /settings?slack_error=<code> (or notion_error=<code>) on failure.
  // Surfaces a toast via the same successMessage / error slots used by
  // tier-change, then clears the query string so a refresh doesn't
  // re-trigger the toast.
  const searchParams = useSearchParams();
  const router = useRouter();
  const { mutate: swrMutate } = useSWRConfig();
  useEffect(() => {
    const slackOk = searchParams.get("slack_connected");
    const slackErr = searchParams.get("slack_error");
    const notionOk = searchParams.get("notion_connected");
    const notionErr = searchParams.get("notion_error");
    const calendarOk = searchParams.get("calendar_connected");
    const calendarErr = searchParams.get("calendar_error");
    if (slackOk) {
      setSuccessMessage("Slack workspace connected.");
      // Invalidate the slack_workspace SWR key so the card flips to
      // "Connected" without a manual refresh. Match-by-prefix so we hit
      // the key regardless of which supabaseUserId is appended. Explicit
      // { revalidate: true } makes the refetch behavior unambiguous.
      swrMutate(
        (key) => Array.isArray(key) && key[0] === "slack_workspace",
        undefined,
        { revalidate: true },
      );
      router.replace("/settings");
    } else if (slackErr) {
      setError(`Slack connection failed: ${slackErr}`);
      router.replace("/settings");
    } else if (notionOk) {
      setSuccessMessage("Notion workspace connected.");
      swrMutate(
        (key) => Array.isArray(key) && key[0] === "notion_integration",
        undefined,
        { revalidate: true },
      );
      router.replace("/settings");
    } else if (notionErr) {
      setError(`Notion connection failed: ${notionErr}`);
      router.replace("/settings");
    } else if (calendarOk) {
      setSuccessMessage("Google Calendar connected.");
      // Invalidate the calendar-credentials key (now user-scoped to
      // [calendar_credentials, supabaseUserId]) AND calendar_today so the
      // dashboard's Today's Calendar section flips from "Connect" to live
      // events without a manual refresh.
      swrMutate(
        (key) => Array.isArray(key) && key[0] === "calendar_credentials",
        undefined,
        { revalidate: true },
      );
      swrMutate(
        (key) => Array.isArray(key) && key[0] === "calendar_today",
        undefined,
        { revalidate: true },
      );
      router.replace("/settings");
    } else if (calendarErr) {
      setError(`Calendar connection failed: ${calendarErr}`);
      router.replace("/settings");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, router]);

  // Sync local state when me data arrives.
  if (me && selectedTier !== currentTier && submitting === false && !confirmOpen) {
    // Only sync when the user hasn't already made a draft selection. Heuristic:
    // when the page first loads, selectedTier === currentTier === me.mhStorageTier.
    // After a user change, they're not aligned — don't clobber the draft.
    // (Initial render of useState(currentTier) handles the first-load case;
    //  this branch only fires if useMe data arrived AFTER the useState call.)
  }

  const isDowngrade = selectedTier < currentTier;
  const isChange = selectedTier !== currentTier;

  if (meError) {
    return (
      <main className="min-h-screen p-6">
        <div className="max-w-2xl mx-auto">
          <Link href="/dashboard" className="text-sm text-gray-600 hover:text-gray-900">
            ← Back to dashboard
          </Link>
          <p className="mt-6 text-sm text-red-600">Could not load your account.</p>
        </div>
      </main>
    );
  }

  if (!me) {
    return (
      <main className="min-h-screen p-6">
        <div className="max-w-2xl mx-auto">
          <p className="text-gray-500 text-sm">Loading…</p>
        </div>
      </main>
    );
  }

  // Re-sync selectedTier the first time me arrives with a value different from
  // the useState initial. This handles the "useMe undefined on mount → loads
  // → user.mhStorageTier=3 but selectedTier still defaulted to 2" race.
  const handleSelect = (t: Tier) => {
    setSelectedTier(t);
    setError(null);
    setSuccessMessage(null);
  };

  const handleSave = async () => {
    setError(null);
    setSuccessMessage(null);
    if (!isChange) return;

    if (isDowngrade) {
      // Open confirm modal — fetch preview counts inside.
      setConfirmOpen(true);
      setTypeConfirm("");
      setPreview(null);
      setPreviewLoading(true);
      const p = await getPreview(selectedTier);
      setPreview(p);
      setPreviewLoading(false);
      return;
    }

    // Upgrade or same: direct API call, no confirmation.
    setSubmitting(true);
    const res = await updateTier(selectedTier);
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error ?? "save_failed");
      return;
    }
    setSuccessMessage(`Storage tier updated to Tier ${selectedTier}.`);
  };

  const handleConfirmedDowngrade = async () => {
    if (typeConfirm !== "DOWNGRADE") return;
    setSubmitting(true);
    setError(null);
    const res = await updateTier(selectedTier);
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error ?? "save_failed");
      setConfirmOpen(false);
      return;
    }
    setConfirmOpen(false);
    const c = res.cleanup;
    const parts: string[] = [];
    if (c) {
      if (c.textNulled > 0) parts.push(`${c.textNulled} text entries removed`);
      if (c.numericNulled > 0)
        parts.push(`${c.numericNulled} numeric entries removed`);
      if (c.correlationsDeleted > 0)
        parts.push(`${c.correlationsDeleted} correlations deleted`);
    }
    setSuccessMessage(
      parts.length > 0
        ? `Storage tier set to Tier ${selectedTier}. ${parts.join(", ")}.`
        : `Storage tier set to Tier ${selectedTier}.`,
    );
  };

  const handleCancelConfirm = () => {
    setConfirmOpen(false);
    setTypeConfirm("");
    // Reset the draft selection back to current — user changed their mind.
    setSelectedTier(currentTier);
  };

  return (
    <main className="min-h-screen bg-gray-50">
      <nav className="border-b border-gray-200 bg-white">
        <div className="max-w-2xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/dashboard" className="text-sm text-gray-600 hover:text-gray-900">
            ← Back to dashboard
          </Link>
          <div className="text-xs text-gray-500">{me.email}</div>
        </div>
      </nav>

      <div className="max-w-2xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-semibold">Settings</h1>

        <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="text-lg font-semibold">Privacy — Mental health data</h2>
          <p className="mt-2 text-sm text-gray-600">
            Choose how deeply Wingman stores your mental health surface data.
            You can change this any time. Downgrades permanently delete the
            higher-tier data we already stored.
          </p>

          <div className="mt-6 space-y-3">
            {TIERS.map((t) => {
              const checked = selectedTier === t.tier;
              const isCurrent = currentTier === t.tier;
              return (
                <label
                  key={t.tier}
                  className={`block rounded-lg border p-4 cursor-pointer transition ${
                    checked
                      ? "border-black bg-gray-50"
                      : "border-gray-200 bg-white hover:border-gray-400"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="radio"
                      name="storage_tier"
                      value={t.tier}
                      checked={checked}
                      onChange={() => handleSelect(t.tier)}
                      disabled={submitting}
                      className="mt-1"
                    />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-gray-900">
                          {t.label}
                        </span>
                        {isCurrent && (
                          <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-700">
                            Current
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-gray-700">{t.oneLine}</p>
                      <ul className="mt-2 list-disc pl-5 text-xs text-gray-600 space-y-0.5">
                        {t.stores.map((s) => (
                          <li key={s}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </label>
              );
            })}
          </div>

          <div className="mt-6 flex items-center justify-end gap-3">
            {successMessage && (
              <span className="text-xs text-green-700">{successMessage}</span>
            )}
            {error && <span className="text-xs text-red-600">{error}</span>}
            <button
              type="button"
              onClick={handleSave}
              disabled={!isChange || submitting}
              className="rounded-md bg-black text-white px-4 py-1.5 text-sm font-medium hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? "Saving…" : isDowngrade ? "Review and confirm" : "Save"}
            </button>
          </div>
        </section>

        <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="text-lg font-semibold">Integrations</h2>
          <p className="mt-2 text-sm text-gray-600">
            Connect external sources so Wingman can ingest and classify content
            alongside your email.
          </p>

          <div className="mt-6 space-y-4">
            <SlackIntegrationCard />
            <NotionIntegrationCard />
            <CalendarIntegrationCard />
          </div>
        </section>
      </div>

      {confirmOpen && (
        <DowngradeConfirmModal
          fromTier={currentTier}
          toTier={selectedTier}
          preview={preview}
          previewLoading={previewLoading}
          typeConfirm={typeConfirm}
          onTypeConfirm={setTypeConfirm}
          submitting={submitting}
          error={error}
          onCancel={handleCancelConfirm}
          onConfirm={handleConfirmedDowngrade}
        />
      )}
    </main>
  );
}

function DowngradeConfirmModal({
  fromTier,
  toTier,
  preview,
  previewLoading,
  typeConfirm,
  onTypeConfirm,
  submitting,
  error,
  onCancel,
  onConfirm,
}: {
  fromTier: Tier;
  toTier: Tier;
  preview: StorageTierPreview | null;
  previewLoading: boolean;
  typeConfirm: string;
  onTypeConfirm: (v: string) => void;
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const canConfirm =
    !submitting && !previewLoading && typeConfirm === "DOWNGRADE";

  const deletionLines: string[] = [];
  if (preview) {
    if (preview.textToBeNulled > 0) {
      deletionLines.push(
        `${preview.textToBeNulled} past text entries (MIP descriptions, inquiry responses, intentions, journal entries)`,
      );
    }
    if (preview.numericToBeNulled > 0) {
      deletionLines.push(
        `${preview.numericToBeNulled} structured score entries (energy, focus, mood, R/Y/G ratings)`,
      );
    }
    if (preview.correlationsToBeDeleted > 0) {
      deletionLines.push(
        `${preview.correlationsToBeDeleted} computed correlations`,
      );
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-lg rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-gray-200 px-5 py-4">
          <h3 className="text-base font-semibold text-gray-900">
            Lower your storage tier?
          </h3>
        </div>

        <div className="px-5 py-5 space-y-4">
          <p className="text-sm text-gray-800">
            You&apos;re moving from <strong>Tier {fromTier}</strong> to{" "}
            <strong>Tier {toTier}</strong>.
          </p>

          {previewLoading && (
            <p className="text-sm text-gray-500">Computing what will be deleted…</p>
          )}

          {!previewLoading && preview && (
            <>
              {deletionLines.length > 0 ? (
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    This will permanently delete:
                  </p>
                  <ul className="mt-2 list-disc pl-5 text-sm text-red-700">
                    {deletionLines.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-sm text-gray-700">
                  Nothing to delete — your higher-tier columns were already empty.
                </p>
              )}

              <div>
                <p className="text-sm font-medium text-gray-900">Keeping:</p>
                <ul className="mt-2 list-disc pl-5 text-sm text-gray-700">
                  <li>Session timestamps and framework choices</li>
                  {toTier >= 2 && (
                    <li>Numeric scores and structured signals</li>
                  )}
                  {toTier >= 3 && <li>Free-text entries</li>}
                </ul>
              </div>

              <p className="text-sm text-gray-700">
                This cannot be undone. Wingman cannot recover deleted data after
                this confirmation.
              </p>

              <div>
                <label className="block text-xs font-medium text-gray-700">
                  Type <span className="font-mono font-semibold">DOWNGRADE</span> to confirm
                </label>
                <input
                  type="text"
                  value={typeConfirm}
                  onChange={(e) => onTypeConfirm(e.target.value)}
                  disabled={submitting}
                  autoFocus
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 disabled:opacity-50"
                />
              </div>
            </>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-gray-200 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-md bg-black text-white px-3 py-1.5 text-sm font-medium hover:bg-gray-800 disabled:opacity-50"
          >
            Keep my Tier {fromTier} data
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canConfirm}
            className="rounded-md bg-red-600 text-white px-3 py-1.5 text-sm font-medium hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? "Deleting…" : "Permanently delete and downgrade"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Tiny "Xs ago / Xm ago / Xh ago / Xd ago" formatter for connected_at /
// last_polled_at. v0: deliberately not pulling date-fns just for this.
function formatRelative(iso: string): string {
  // Guard clock skew (server clock ahead of client) — clamp negatives to 0
  // so we don't render "-3s ago".
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function SlackIcon({ className = "h-5 w-5" }: { className?: string }) {
  // Slack mark — official colorway. Inline SVG keeps the build dep-free.
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        fill="#E01E5A"
        d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z"
      />
      <path
        fill="#36C5F0"
        d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z"
      />
      <path
        fill="#2EB67D"
        d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z"
      />
      <path
        fill="#ECB22E"
        d="M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"
      />
    </svg>
  );
}

function SlackIntegrationCard() {
  const { data: workspace, isLoading } = useSlackWorkspace();
  const disconnect = useDisconnectSlack();
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleDisconnect = async () => {
    const teamLabel = workspace?.team_name ?? workspace?.team_id ?? "this workspace";
    if (
      !window.confirm(
        `Disconnect Slack — ${teamLabel}? This will stop syncing until you reconnect. You can reconnect anytime (and pick a different workspace).`,
      )
    ) {
      return;
    }
    setBusy(true);
    setLocalError(null);
    const res = await disconnect();
    setBusy(false);
    if (!res.ok) setLocalError(res.error ?? "disconnect_failed");
  };

  if (isLoading) {
    return <p className="cred-ui-lower text-[13px] text-[var(--cred-text-meta)]">loading…</p>;
  }

  // Not connected.
  if (!workspace) {
    return (
      <div className="flex items-start justify-between gap-4 rounded-[6px] border border-[var(--cred-border)] bg-[var(--cred-card-bg)] p-4">
        <div className="flex items-start gap-3">
          <SlackIcon className="mt-0.5 h-6 w-6" />
          <div>
            <div className="text-[14px] font-medium text-[var(--cred-text-primary)]">Slack</div>
            <p className="mt-1 text-[13px] text-[var(--cred-text-secondary)]">
              Connect a Slack workspace to ingest DMs alongside email.
            </p>
          </div>
        </div>
        <a
          href="/api/slack/oauth/start"
          className="cred-ui-lower shrink-0 rounded-[4px] bg-[var(--cred-text-primary)] px-4 py-1.5 text-[13px] font-medium tracking-[0.01em] text-[var(--cred-card-bg)] hover:opacity-90"
        >
          connect slack
        </a>
      </div>
    );
  }

  // Connected — disconnected token (revoked / expired).
  if (workspace.status === "disconnected") {
    return (
      <div className="flex items-start justify-between gap-4 rounded-[6px] border border-[var(--cred-border)] bg-[var(--cred-card-bg)] p-4">
        <div className="flex items-start gap-3">
          <SlackIcon className="mt-0.5 h-6 w-6" />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-medium text-[var(--cred-text-primary)]">
                Slack — {workspace.team_name ?? workspace.team_id}
              </span>
              <span
                className="cred-ui-lower rounded-[3px] px-2 py-0.5 text-[11px] tracking-[0.02em]"
                style={{
                  backgroundColor: "var(--chip-red-bg)",
                  color: "var(--chip-red-fg)",
                }}
              >
                disconnected
              </span>
            </div>
            <p className="mt-1 text-[13px] text-[var(--cred-text-secondary)]">
              Slack token expired or revoked.
            </p>
            {workspace.disconnected_at && (
              <p className="mt-1 text-[12px] text-[var(--cred-text-meta)]">
                Disconnected {formatRelative(workspace.disconnected_at)}
              </p>
            )}
          </div>
        </div>
        <a
          href="/api/slack/oauth/start"
          className="cred-ui-lower shrink-0 rounded-[4px] bg-[var(--cred-text-primary)] px-4 py-1.5 text-[13px] font-medium tracking-[0.01em] text-[var(--cred-card-bg)] hover:opacity-90"
        >
          reconnect slack
        </a>
      </div>
    );
  }

  // Connected + active.
  return (
    <div className="flex items-start justify-between gap-4 rounded-[6px] border border-[var(--cred-border)] bg-[var(--cred-card-bg)] p-4">
      <div className="flex items-start gap-3">
        <SlackIcon className="mt-0.5 h-6 w-6" />
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-medium text-[var(--cred-text-primary)]">
              Slack — {workspace.team_name ?? workspace.team_id}
            </span>
            <span
              className="cred-ui-lower rounded-[3px] px-2 py-0.5 text-[11px] tracking-[0.02em]"
              style={{
                backgroundColor: "var(--chip-green-bg)",
                color: "var(--chip-green-fg)",
              }}
            >
              connected
            </span>
          </div>
          <p className="mt-1 text-[12px] text-[var(--cred-text-secondary)]">
            Connected {formatRelative(workspace.connected_at)}
          </p>
          {workspace.last_polled_at && (
            <p className="mt-0.5 text-[12px] text-[var(--cred-text-meta)]">
              Last sync: {formatRelative(workspace.last_polled_at)}
            </p>
          )}
          {localError && (
            <p className="mt-1 text-[12px] text-[var(--chip-red-fg)]">{localError}</p>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={handleDisconnect}
        disabled={busy}
        className="cred-ui-lower shrink-0 text-[12px] text-[var(--cred-text-secondary)] underline hover:text-[var(--cred-text-primary)] disabled:opacity-50"
      >
        {busy ? "disconnecting…" : "disconnect"}
      </button>
    </div>
  );
}

// Simple Notion-style page mark — distinguishable from the Slack rainbow at a
// glance (single solid color, page-icon silhouette). Deliberately not the
// exact brand wordmark — keeps us out of brand-asset compliance for v0 while
// remaining recognizable next to the Slack glyph.
function NotionIcon({ className = "h-5 w-5" }: { className?: string }) {
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

function NotionIntegrationCard() {
  const { data: integration, isLoading } = useNotionIntegration();
  const disconnect = useDisconnectNotion();
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleDisconnect = async () => {
    const wsLabel =
      integration?.workspace_name ??
      integration?.workspace_id ??
      "this workspace";
    if (
      !window.confirm(
        `Disconnect Notion — ${wsLabel}? This will stop syncing until you reconnect. You can reconnect anytime (and pick a different workspace).`,
      )
    ) {
      return;
    }
    setBusy(true);
    setLocalError(null);
    const res = await disconnect();
    setBusy(false);
    if (!res.ok) setLocalError(res.error ?? "disconnect_failed");
  };

  if (isLoading) {
    return <p className="cred-ui-lower text-[13px] text-[var(--cred-text-meta)]">loading…</p>;
  }

  // Not connected.
  if (!integration) {
    return (
      <div className="flex items-start justify-between gap-4 rounded-[6px] border border-[var(--cred-border)] bg-[var(--cred-card-bg)] p-4">
        <div className="flex items-start gap-3">
          <NotionIcon className="mt-0.5 h-6 w-6" />
          <div>
            <div className="text-[14px] font-medium text-[var(--cred-text-primary)]">Notion</div>
            <p className="mt-1 text-[13px] text-[var(--cred-text-secondary)]">
              Connect a Notion workspace so Wingman classifies recent page
              edits alongside email.
            </p>
          </div>
        </div>
        <a
          href="/api/notion/oauth/start"
          className="cred-ui-lower shrink-0 rounded-[4px] bg-[var(--cred-text-primary)] px-4 py-1.5 text-[13px] font-medium tracking-[0.01em] text-[var(--cred-card-bg)] hover:opacity-90"
        >
          connect notion
        </a>
      </div>
    );
  }

  // Connected — disconnected token (revoked / expired).
  if (integration.status === "disconnected") {
    return (
      <div className="flex items-start justify-between gap-4 rounded-[6px] border border-[var(--cred-border)] bg-[var(--cred-card-bg)] p-4">
        <div className="flex items-start gap-3">
          <NotionIcon className="mt-0.5 h-6 w-6" />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-medium text-[var(--cred-text-primary)]">
                Notion — {integration.workspace_name ?? integration.workspace_id}
              </span>
              <span
                className="cred-ui-lower rounded-[3px] px-2 py-0.5 text-[11px] tracking-[0.02em]"
                style={{
                  backgroundColor: "var(--chip-red-bg)",
                  color: "var(--chip-red-fg)",
                }}
              >
                disconnected
              </span>
            </div>
            <p className="mt-1 text-[13px] text-[var(--cred-text-secondary)]">
              Notion token expired or revoked.
            </p>
            {integration.disconnected_at && (
              <p className="mt-1 text-[12px] text-[var(--cred-text-meta)]">
                Disconnected {formatRelative(integration.disconnected_at)}
              </p>
            )}
          </div>
        </div>
        <a
          href="/api/notion/oauth/start"
          className="cred-ui-lower shrink-0 rounded-[4px] bg-[var(--cred-text-primary)] px-4 py-1.5 text-[13px] font-medium tracking-[0.01em] text-[var(--cred-card-bg)] hover:opacity-90"
        >
          reconnect notion
        </a>
      </div>
    );
  }

  // Connected + active.
  return (
    <div className="flex items-start justify-between gap-4 rounded-[6px] border border-[var(--cred-border)] bg-[var(--cred-card-bg)] p-4">
      <div className="flex items-start gap-3">
        <NotionIcon className="mt-0.5 h-6 w-6" />
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-medium text-[var(--cred-text-primary)]">
              Notion — {integration.workspace_name ?? integration.workspace_id}
            </span>
            <span
              className="cred-ui-lower rounded-[3px] px-2 py-0.5 text-[11px] tracking-[0.02em]"
              style={{
                backgroundColor: "var(--chip-green-bg)",
                color: "var(--chip-green-fg)",
              }}
            >
              connected
            </span>
          </div>
          <p className="mt-1 text-[12px] text-[var(--cred-text-secondary)]">
            Connected {formatRelative(integration.connected_at)}
          </p>
          {integration.last_polled_at && (
            <p className="mt-0.5 text-[12px] text-[var(--cred-text-meta)]">
              Last sync: {formatRelative(integration.last_polled_at)}
            </p>
          )}
          {localError && (
            <p className="mt-1 text-[12px] text-[var(--chip-red-fg)]">{localError}</p>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={handleDisconnect}
        disabled={busy}
        className="cred-ui-lower shrink-0 text-[12px] text-[var(--cred-text-secondary)] underline hover:text-[var(--cred-text-primary)] disabled:opacity-50"
      >
        {busy ? "disconnecting…" : "disconnect"}
      </button>
    </div>
  );
}

// Simple distinguishable calendar glyph — boxed grid with the top binding and
// a check tick inside. Single solid color, deliberately NOT Google Calendar's
// rainbow brand-mark so we stay clear of brand-asset compliance for v0 while
// remaining recognizable next to the Slack/Notion glyphs above.
function CalendarIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="8" y1="3" x2="8" y2="6" />
      <line x1="16" y1="3" x2="16" y2="6" />
      <polyline points="9 14 11 16 15 12" />
    </svg>
  );
}

// Outlook / Apple Calendar interop note. Per Tab 1 D4: rendered inline as a
// collapsible <details> here in /settings rather than as a separate
// /docs/calendar-interop route. Plain text only — no external link.
function OutlookInteropNote() {
  return (
    <details className="mt-3 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700">
      <summary className="cursor-pointer font-medium text-gray-800">
        Using Outlook or Apple Calendar?
      </summary>
      <div className="mt-2 space-y-2 text-gray-700">
        <p>
          You can subscribe your work calendar into Google Calendar, then
          connect Google here.
        </p>
        <p>
          <strong>Outlook:</strong> Go to outlook.com → Settings → Calendar →
          Shared calendars → Publish a calendar → copy the ICS link. In Google
          Calendar, add a new calendar via &ldquo;From URL&rdquo; and paste it.
        </p>
        <p>
          <strong>Apple Calendar:</strong> File → New Calendar Subscription →
          paste your CalDAV/ICS URL.
        </p>
        <p className="text-gray-500">
          Sync takes a few minutes the first time.
        </p>
      </div>
    </details>
  );
}

function CalendarIntegrationCard() {
  const { data: credentials, isLoading } = useCalendarCredentials();
  const disconnect = useDisconnectCalendar();
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  if (isLoading) {
    return <p className="cred-ui-lower text-[13px] text-[var(--cred-text-meta)]">loading…</p>;
  }

  const handleDisconnect = async () => {
    if (
      !window.confirm(
        "Disconnect Google Calendar? This will stop syncing meetings until you reconnect.",
      )
    ) {
      return;
    }
    setBusy(true);
    setLocalError(null);
    const res = await disconnect();
    setBusy(false);
    if (!res.ok) setLocalError(res.error ?? "disconnect_failed");
  };

  // Not connected (no row at all).
  if (!credentials) {
    return (
      <div className="rounded-[6px] border border-[var(--cred-border)] bg-[var(--cred-card-bg)] p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <CalendarIcon className="mt-0.5 h-6 w-6 text-[var(--cred-text-secondary)]" />
            <div>
              <div className="text-[14px] font-medium text-[var(--cred-text-primary)]">
                Google Calendar
              </div>
              <p className="mt-1 text-[13px] text-[var(--cred-text-secondary)]">
                Connect Google Calendar to see today&apos;s meetings and get
                prep priorities surfaced.
              </p>
            </div>
          </div>
          <a
            href="/api/google/calendar/oauth/start"
            className="cred-ui-lower shrink-0 rounded-[4px] bg-[var(--cred-text-primary)] px-4 py-1.5 text-[13px] font-medium tracking-[0.01em] text-[var(--cred-card-bg)] hover:opacity-90"
          >
            connect calendar
          </a>
        </div>
        <OutlookInteropNote />
      </div>
    );
  }

  // Disconnected (row exists, status=disconnected).
  if (credentials.status === "disconnected") {
    return (
      <div className="rounded-[6px] border border-[var(--cred-border)] bg-[var(--cred-card-bg)] p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <CalendarIcon className="mt-0.5 h-6 w-6 text-[var(--cred-text-secondary)]" />
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-medium text-[var(--cred-text-primary)]">
                  Google Calendar
                </span>
                <span
                  className="cred-ui-lower rounded-[3px] px-2 py-0.5 text-[11px] tracking-[0.02em]"
                  style={{
                    backgroundColor: "var(--chip-red-bg)",
                    color: "var(--chip-red-fg)",
                  }}
                >
                  disconnected
                </span>
              </div>
              <p className="mt-1 text-[13px] text-[var(--cred-text-secondary)]">
                Calendar token expired or revoked.
              </p>
              {credentials.disconnected_at && (
                <p className="mt-1 text-[12px] text-[var(--cred-text-meta)]">
                  Disconnected {formatRelative(credentials.disconnected_at)}
                </p>
              )}
            </div>
          </div>
          <a
            href="/api/google/calendar/oauth/start"
            className="cred-ui-lower shrink-0 rounded-[4px] bg-[var(--cred-text-primary)] px-4 py-1.5 text-[13px] font-medium tracking-[0.01em] text-[var(--cred-card-bg)] hover:opacity-90"
          >
            reconnect calendar
          </a>
        </div>
        <OutlookInteropNote />
      </div>
    );
  }

  // Connected + active.
  return (
    <div className="rounded-[6px] border border-[var(--cred-border)] bg-[var(--cred-card-bg)] p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <CalendarIcon className="mt-0.5 h-6 w-6 text-[var(--cred-text-secondary)]" />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-medium text-[var(--cred-text-primary)]">
                Google Calendar
              </span>
              <span
                className="cred-ui-lower rounded-[3px] px-2 py-0.5 text-[11px] tracking-[0.02em]"
                style={{
                  backgroundColor: "var(--chip-green-bg)",
                  color: "var(--chip-green-fg)",
                }}
              >
                connected
              </span>
            </div>
            <p className="mt-1 text-[12px] text-[var(--cred-text-secondary)]">
              Connected {formatRelative(credentials.connected_at)}
            </p>
            <p className="mt-0.5 text-[12px] text-[var(--cred-text-meta)]">
              Last sync: {formatRelative(credentials.updated_at)}
            </p>
            {localError && (
              <p className="mt-1 text-[12px] text-[var(--chip-red-fg)]">{localError}</p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={handleDisconnect}
          disabled={busy}
          className="cred-ui-lower shrink-0 text-[12px] text-[var(--cred-text-secondary)] underline hover:text-[var(--cred-text-primary)] disabled:opacity-50"
        >
          {busy ? "disconnecting…" : "disconnect"}
        </button>
      </div>
      <OutlookInteropNote />
    </div>
  );
}
