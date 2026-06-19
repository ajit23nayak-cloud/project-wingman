"use client";

// Shared dashboard primitives for the Superhuman-inspired redesign
// (spec: coordination/log.md 08:30 + 08:55 UTC 2026-06-18).
//
// Row pattern: [8px dot] [56px mono time] [flex title] [badge] [hint]
// All 7 dashboard sections + MH banner-stack use DashboardRow.
// All section headers use DashboardSectionHeader (compact 11px lowercase + count).
// All sections wrap in DashboardSection (10px padding, 0.5px separator).

import Link from "next/link";
import type { MouseEvent, MouseEventHandler, ReactNode } from "react";
import type { FeedbackSourceTable } from "@/lib/supabase/hooks";
import { RowCommentIndicator } from "@/components/feedback/RowCommentIndicator";

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

  const inner = (
    <div
      className={`flex items-center gap-3 px-2 py-1.5 ${
        fade ? "opacity-50" : ""
      }`}
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[dot]}`}
        aria-label={dotLabel}
      />
      <span className="min-w-[56px] shrink-0 font-mono text-xs text-gray-500">
        {time}
      </span>
      <span className="flex-1 truncate text-sm font-medium text-gray-900">
        {title}
      </span>
      <span className="flex shrink-0 items-center">
        <span className="rounded border-[0.5px] border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono text-[11px] lowercase text-gray-500">
          {badge}
        </span>
        {hasSource && (
          <RowCommentIndicator
            sourceTable={sourceTable as FeedbackSourceTable}
            sourceId={sourceId as string}
          />
        )}
      </span>
      <span className="ml-2 shrink-0 font-mono text-[11px] lowercase text-gray-500 group-hover:text-gray-900">
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
    "group block w-full text-left hover:bg-gray-50 transition-colors";

  if (href) {
    // Internal Wingman route — always use Next Link so prefetch + soft nav
    // work, even in new-tab mode (Next Link supports the `target` prop).
    // External URL (http/mailto/slack://etc) — use raw <a>.
    const isInternal = href.startsWith("/");
    if (isInternal) {
      return (
        <Link
          href={href}
          target={external ? "_blank" : undefined}
          rel={external ? "noopener noreferrer" : undefined}
          className={wrapperClass}
          onClick={onClick}
        >
          {inner}
        </Link>
      );
    }
    return (
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
  }
  if (onClick) {
    // Use <div role="button"> instead of <button> here because the row
    // contains a nested interactive (the 💬 affordance is a span with
    // role="button"). A <button> inside a <button> is invalid HTML and
    // breaks accessibility. <a> can host a role="button" child per a
    // WHATWG carve-out, so the href branches above are unaffected.
    return (
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
  }
  return <div className={wrapperClass}>{inner}</div>;
}

type DashboardSectionHeaderProps = {
  title: string;
  count?: string | null;
};

// Compact section header — 11px, weight 500, grey-tertiary, lowercase.
// Optional count badge on the right (e.g., "3 cold", "2 overdue").
export function DashboardSectionHeader({
  title,
  count,
}: DashboardSectionHeaderProps) {
  return (
    <div className="mb-1 flex items-center justify-between px-2">
      <h2 className="text-[11px] font-medium lowercase tracking-wide text-gray-400">
        {title}
      </h2>
      {count && (
        <span className="font-mono text-[11px] lowercase text-gray-400">
          {count}
        </span>
      )}
    </div>
  );
}

type DashboardSectionProps = {
  children: ReactNode;
  className?: string;
};

// Section wrapper — 10px (py-2.5) padding inside, 0.5px top border so
// adjacent sections render a hairline divider. The first section's top
// border is hidden by the parent (set border-t-0 on its outer wrapper).
export function DashboardSection({
  children,
  className = "",
}: DashboardSectionProps) {
  return (
    <section
      className={`max-w-4xl mx-auto border-t-[0.5px] border-gray-200 py-2.5 ${className}`}
    >
      {children}
    </section>
  );
}

// Container for stacked rows — 0.5px hairline divider between rows.
export function DashboardRowList({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y-[0.5px] divide-gray-100">{children}</div>
  );
}

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
