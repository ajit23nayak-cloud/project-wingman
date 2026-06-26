"use client";

// Shared dashboard primitives for the Superhuman-inspired redesign
// (spec: coordination/log.md 08:30 + 08:55 UTC 2026-06-18).
//
// Row pattern: [8px dot] [56px mono time] [flex title] [badge] [hint]
// All 7 dashboard sections + MH banner-stack use DashboardRow.
// All section headers use DashboardSectionHeader (compact 11px lowercase + count).
// All sections wrap in DashboardSection (10px padding, 0.5px separator).

import Link from "next/link";
import type { CSSProperties, MouseEvent, MouseEventHandler, ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { FeedbackSourceTable } from "@/lib/supabase/hooks";
import { RowCommentIndicator } from "@/components/feedback/RowCommentIndicator";
import { SOURCE_ICON } from "@/components/icons/SourceIcons";
import { RowActions, type RowAction } from "@/components/dashboard/RowActions";

export type DashboardDotColor = "red" | "amber" | "green" | "grey";

export type DashboardBadge =
  | "gmail"
  | "slack"
  | "notion"
  | "calendar"
  | "cadence"
  | "postmortem"
  | "okr"
  | "mh"
  | "daily"
  | "ritual"
  | "nudge"
  | "help";

const DOT_CLASS: Record<DashboardDotColor, string> = {
  red: "bg-red-500",
  amber: "bg-amber-500",
  green: "bg-green-500",
  grey: "bg-gray-300",
};

type DashboardRowProps = {
  dot: DashboardDotColor;
  dotLabel: string;
  time: string;
  title: string;
  badge: DashboardBadge;
  hint: string;
  // Navigation: when href present, row renders as <a> or <Link>. external opens
  // in new tab; internal uses Next Link in same tab.
  href?: string;
  external?: boolean;
  // Click-only (no href): renders as <button>. Used for OKR/Calendar
  // expand-on-click. If both href and onClick are set, href wins and onClick
  // is ignored.
  onClick?: MouseEventHandler<HTMLElement>;
  // Visual fade for archived/sent rows.
  fade?: boolean;
  // Commit 12 feedback hook-up. When sourceTable+sourceId are set, a
  // RowCommentIndicator (orange dot) renders in the badge area for rows
  // with open notes. When onCommentClick is ALSO set, a hover-visible
  // "💬" affordance renders on the right and fires the callback with the
  // clicked element + row title (used by DashboardView to anchor the
  // FeedbackPopover).
  sourceTable?: FeedbackSourceTable;
  sourceId?: string;
  onCommentClick?: (anchorEl: HTMLElement, prefilledTitle: string) => void;
  // Mega-commit B 13a: inline quick actions (snooze for v0). Hover-revealed
  // icon buttons in the right-hand area, between the badge and the 💬
  // affordance. Pass undefined or [] for no actions.
  actions?: RowAction[];
};

// Single dashboard row — pure visual. No internal state; callers wrap with
// expansion logic if they need it. Whole row is the click target; the hint
// text on the right is the visual affordance.
export function DashboardRow({
  dot,
  dotLabel,
  time,
  title,
  badge,
  hint,
  href,
  external,
  onClick,
  fade,
  sourceTable,
  sourceId,
  onCommentClick,
  actions,
}: DashboardRowProps) {
  // Commit 12: only render the comment-affordance + indicator when the row
  // is wired with both sourceTable and sourceId. This keeps backwards-compat
  // with rows that haven't been threaded yet.
  const hasSource = !!(sourceTable && sourceId);
  const canComment = hasSource && !!onCommentClick;

  // The comment button is rendered as an interactive <span> with role/tabIndex
  // rather than a <button> because DashboardRow's outer element is often an
  // <a>/<Link>, and a <button> inside an <a> is invalid HTML. The span sits
  // INSIDE the wrapper but stops propagation on click/key so it doesn't fire
  // the wrapper's navigation. (See spec note: "absolute-positioned-link" is
  // the alternative, but rejected here — it would require restructuring every
  // existing wrapper branch and risks regressing the row's click target.)
  const handleCommentClick = (e: MouseEvent<HTMLSpanElement>) => {
    if (!onCommentClick) return;
    e.preventDefault();
    e.stopPropagation();
    onCommentClick(e.currentTarget, title);
  };

  const Icon = SOURCE_ICON[badge] ?? null;
  // Cred + Newspaper row chrome (Commit 15): time uses tabular-nums Inter
  // (was font-mono), badge gets the cream card bg, hint goes lowercase via
  // cred-ui-lower. `dash-row-inner` removed — density toggle is gone.
  const inner = (
    <div
      className={`flex items-center gap-3 px-3 py-2 ${
        fade ? "opacity-50" : ""
      }`}
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[dot]}`}
        aria-label={dotLabel}
      />
      <span className="min-w-[56px] shrink-0 text-[12px] tabular-nums text-[var(--cred-text-meta)]">
        {time}
      </span>
      <span className="flex-1 truncate text-[14.5px] text-[var(--cred-text-primary)]">
        {title}
      </span>
      <span className="flex shrink-0 items-center">
        <span
          className="cred-ui-lower inline-flex items-center justify-center rounded-[3px] border border-[var(--cred-border)] bg-[var(--cred-card-bg)] px-1.5 py-0.5 text-[11px] tracking-[0.02em] text-[var(--cred-text-secondary)]"
          title={badge}
          aria-label={badge}
        >
          {Icon ? <Icon className="h-3.5 w-3.5" /> : badge}
        </span>
        {hasSource && (
          <RowCommentIndicator
            sourceTable={sourceTable as FeedbackSourceTable}
            sourceId={sourceId as string}
          />
        )}
      </span>
      {actions && actions.length > 0 && <RowActions actions={actions} />}
      <span className="cred-ui-lower ml-2 shrink-0 text-[11px] tabular-nums text-[var(--cred-text-meta)] group-hover:text-[var(--cred-text-primary)]">
        {hint}
      </span>
      {canComment && (
        <span
          role="button"
          tabIndex={0}
          aria-label="Add comment"
          onClick={handleCommentClick}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              if (onCommentClick) {
                onCommentClick(e.currentTarget, title);
              }
            }
          }}
          className="ml-1 shrink-0 cursor-pointer rounded px-1 text-xs opacity-0 transition-opacity hover:bg-gray-100 group-hover:opacity-100"
        >
          💬
        </span>
      )}
    </div>
  );

  const wrapperClass =
    "group block w-full text-left hover:bg-[var(--cred-border-soft)]/40 transition-colors";

  // Mega-commit A #15: rows fade out smoothly when archived/snoozed/dismissed.
  // Outer wrapper is a motion.div so AnimatePresence in DashboardRowList can
  // pick up the exit animation. The actual click target (Link/<a>/<button>)
  // sits inside.
  const motionProps = {
    layout: true,
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0, height: 0 },
    transition: { duration: 0.2, ease: "easeOut" as const },
  };

  let body: ReactNode;
  if (href) {
    const isInternal = href.startsWith("/");
    body = isInternal ? (
      <Link
        href={href}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
        className={wrapperClass}
        onClick={onClick}
      >
        {inner}
      </Link>
    ) : (
      <a
        href={href}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
        className={wrapperClass}
        onClick={onClick}
      >
        {inner}
      </a>
    );
  } else if (onClick) {
    body = (
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick?.(e as unknown as MouseEvent<HTMLDivElement>);
          }
        }}
        className={wrapperClass}
      >
        {inner}
      </div>
    );
  } else {
    body = <div className={wrapperClass}>{inner}</div>;
  }
  return <motion.div {...motionProps}>{body}</motion.div>;
}

export type ChipColor = "red" | "amber" | "green" | "grey";

const CHIP_STYLE: Record<ChipColor, CSSProperties> = {
  red: { backgroundColor: "var(--chip-red-bg)", color: "var(--chip-red-fg)" },
  amber: { backgroundColor: "var(--chip-amber-bg)", color: "var(--chip-amber-fg)" },
  green: { backgroundColor: "var(--chip-green-bg)", color: "var(--chip-green-fg)" },
  grey: { backgroundColor: "var(--chip-grey-bg)", color: "var(--chip-grey-fg)" },
};

type DashboardSectionHeaderProps = {
  title: string;
  count?: string | null;
  // Mega-commit A #16: color the count pill by urgency (e.g. decisions overdue
  // = red, cadence amber). Omit to fall back to plain grey text.
  chipColor?: ChipColor;
};

// Newspaper-style section header (Commit 15): cream-card strip with warm
// hairline top/bottom, gold ✦ flourish + lowercase title at 15px/500. Count
// chip moves inside the same strip on the right. Replaces the previous
// 11px footnote header — now feels like the masthead of a section.
export function DashboardSectionHeader({
  title,
  count,
  chipColor,
}: DashboardSectionHeaderProps) {
  return (
    <div className="flex items-center justify-between border-y border-[var(--cred-border)] bg-[var(--cred-card-bg)] px-4 py-2">
      <h2 className="cred-ui-lower flex items-center gap-2 text-[15px] font-medium tracking-[-0.01em] text-[var(--cred-text-primary)]">
        <span aria-hidden="true" className="text-[var(--cred-flourish)]">
          ✦
        </span>
        {title}
      </h2>
      {count &&
        (chipColor ? (
          <span
            className="cred-ui-lower inline-block rounded-[3px] px-2 py-0.5 text-[11px] tabular-nums tracking-[0.02em]"
            style={CHIP_STYLE[chipColor]}
          >
            {count}
          </span>
        ) : (
          <span className="cred-ui-lower text-[12px] tabular-nums text-[var(--cred-text-meta)]">
            {count}
          </span>
        ))}
    </div>
  );
}

type DashboardSectionProps = {
  children: ReactNode;
  className?: string;
  // Commit 15 NOTE: `accentColor` is accepted for back-compat with sub-views
  // that still pass it from Mega-commit A's pattern, but it's now a no-op.
  // The Cred design replaces the 4px vertical bar with the newspaper-strip
  // section header (DashboardSectionHeader handles the visual demarcation).
  // SECTION_ACCENTS exports remain — they still color row dots indirectly
  // via the dotFor* resolvers in some sub-views.
  accentColor?: string;
};

// Section wrapper (Commit 15): cream-card group on the cream-page bg, with
// hairline border around the whole section. Section header sits inside as
// a full-width newspaper strip; row content fills the rest of the card.
export function DashboardSection({
  children,
  className = "",
}: DashboardSectionProps) {
  return (
    <section
      className={`max-w-4xl mx-auto mt-6 overflow-hidden rounded-[6px] border border-[var(--cred-border)] bg-[var(--cred-card-bg)] ${className}`}
    >
      {children}
    </section>
  );
}

// Container for stacked rows — warm hairline divider between rows. Wrapped
// in AnimatePresence so DashboardRow's exit animation runs when rows unmount.
export function DashboardRowList({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-[var(--cred-border-soft)]">
      <AnimatePresence initial={false}>{children}</AnimatePresence>
    </div>
  );
}

// ---------- Section accent palette (Mega-commit A #8) ----------

// Map of section name → CSS-var accent color. Build C threads these into
// DashboardSection's accentColor prop. Keep names in sync with the section
// headers (`alerts`, `cadence`, `decisions`, `okrs`, `calendar`, `slack`,
// `notion`, `email`).
export const SECTION_ACCENTS: Record<string, string> = {
  alerts: "var(--accent-alerts)",
  cadence: "var(--accent-cadence)",
  decisions: "var(--accent-decisions)",
  okrs: "var(--accent-okrs)",
  calendar: "var(--accent-calendar)",
  slack: "var(--accent-slack)",
  notion: "var(--accent-notion)",
  email: "var(--accent-email)",
};

// ---------- Shared formatters ----------

// Relative-age formatter used by email/Slack/Notion/OKR/cadence rows.
// Same-day → HH:MM (locale 24h). 1-23 hours → "Nh ago". 1+ days → "Nd ago".
export function formatRelativeAge(timestampMs: number): string {
  const now = Date.now();
  const diff = now - timestampMs;
  if (diff < 0) return "now";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    // Same-day-ish: prefer the wallclock time so the founder can pattern-
    // match against "the email from 10:42 this morning."
    const d = new Date(timestampMs);
    const nowDate = new Date();
    if (
      d.getFullYear() === nowDate.getFullYear() &&
      d.getMonth() === nowDate.getMonth() &&
      d.getDate() === nowDate.getDate()
    ) {
      return d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    }
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Time formatter for calendar events — HH:MM (24h).
export function formatClock24(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// Cadence break formatter — "42d" style.
export function formatCadenceDays(days: number | null): string {
  if (!days) return "0d";
  return `${days}d`;
}

// Decision postmortem countdown — "-3d" overdue / "+12d" upcoming.
export function formatPostmortemDays(dueAtIso: string | null): string {
  if (!dueAtIso) return "—";
  const diffDays = Math.round(
    (new Date(dueAtIso).getTime() - Date.now()) / 86400000,
  );
  if (diffDays === 0) return "today";
  return diffDays > 0 ? `+${diffDays}d` : `${diffDays}d`;
}

// ---------- Status dot resolvers ----------

export function dotForCadenceDays(days: number | null): DashboardDotColor {
  if (days == null) return "grey";
  if (days >= 28) return "red";
  if (days >= 14) return "amber";
  return "green";
}

export function dotForPostmortemDue(
  dueAtIso: string | null,
): DashboardDotColor {
  if (!dueAtIso) return "grey";
  const diffDays = Math.round(
    (new Date(dueAtIso).getTime() - Date.now()) / 86400000,
  );
  if (diffDays < 0) return "red";
  if (diffDays <= 7) return "amber";
  return "grey";
}

export function dotForClassification(
  classification: string | null,
): DashboardDotColor {
  switch (classification) {
    case "urgent":
      return "red";
    case "important":
      return "amber";
    case "fyi":
      return "grey";
    case "archive":
      return "grey";
    default:
      return "grey";
  }
}

export function dotForPrepPriority(
  priority: string | null | undefined,
): DashboardDotColor {
  switch (priority) {
    case "high":
      return "red";
    case "medium":
      return "amber";
    case "low":
      return "grey";
    case "none":
      return "grey";
    default:
      return "grey";
  }
}

// KR confidence rollup → dot color. Rule: red if any KR red, else amber if
// any KR yellow, else green. Documented inline per spec gap callout.
export function dotForKrRollup(
  confidences: Array<string | null | undefined>,
): DashboardDotColor {
  if (confidences.some((c) => c === "red")) return "red";
  if (confidences.some((c) => c === "yellow" || c === "amber")) return "amber";
  if (confidences.some((c) => c === "green")) return "green";
  return "grey";
}

// ---------- Slack permalink builder ----------

// Slack permalink construction — slack_messages doesn't store a permalink
// (migration 0014). slack_workspaces stores team_id but NOT the workspace
// subdomain, so we can't build the canonical
// https://<subdomain>.slack.com/archives/... format. Fall back to the
// web-client deep link which works given team_id + channel_id and
// transparently redirects to the correct workspace. Doesn't deep-link to
// the specific message, but lands the user in the right channel.
export function buildSlackChannelLink(
  teamId: string | null | undefined,
  channelId: string,
): string {
  if (!teamId) return `https://app.slack.com/client`;
  return `https://app.slack.com/client/${teamId}/${channelId}`;
}
