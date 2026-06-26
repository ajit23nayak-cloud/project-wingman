// Embedded dashboard preview rendered on the homepage (Commit 17). Pure
// visual — no SWR hooks, no data fetch, fully static sample data. Mirrors
// the actual dashboard chrome (Cred + Newspaper from Commit 15) so the
// visitor sees exactly what they'd wake up to.
//
// All sample data hardcoded inline; matches the prototype at
// wingman-homepage-prototype.html L1088-1234.

import { VoiceDigestPlayer } from "./VoiceDigestPlayer";

type DotColor = "rose" | "amber" | "blue" | "grey" | "violet";
type ChipTone = "rose" | "amber" | "blue" | "emerald" | "violet" | "grey";

const DOT_BG: Record<DotColor, string> = {
  rose: "#f43f5e",
  amber: "#f59e0b",
  blue: "#3b82f6",
  grey: "#c4bdb0",
  violet: "#8b5cf6",
};

const CHIP_STYLE: Record<ChipTone, { bg: string; fg: string }> = {
  rose: { bg: "var(--chip-red-bg)", fg: "var(--chip-red-fg)" },
  amber: { bg: "var(--chip-amber-bg)", fg: "var(--chip-amber-fg)" },
  blue: { bg: "var(--chip-blue-bg)", fg: "var(--chip-blue-fg)" },
  emerald: { bg: "var(--chip-green-bg)", fg: "var(--chip-green-fg)" },
  violet: { bg: "var(--chip-violet-bg)", fg: "var(--chip-violet-fg)" },
  grey: { bg: "var(--chip-grey-bg)", fg: "var(--chip-grey-fg)" },
};

type Row = {
  dot: DotColor;
  time: string;
  title: string;
  chip: { label: string; tone: ChipTone };
};

type Section = {
  title: string;
  meta: string;
  rows: Row[];
};

const SECTIONS: Section[] = [
  {
    title: "needs you",
    meta: "3 items",
    rows: [
      {
        dot: "rose",
        time: "-4d",
        title: "Sequoia term sheet redline — overdue",
        chip: { label: "urgent", tone: "rose" },
      },
      {
        dot: "amber",
        time: "6d",
        title: "domain wingman.dev expires this week",
        chip: { label: "action", tone: "amber" },
      },
      {
        dot: "amber",
        time: "2d",
        title: "Q3 board deck needs your approval",
        chip: { label: "action", tone: "amber" },
      },
    ],
  },
  {
    title: "slack",
    meta: "3 unread",
    rows: [
      {
        dot: "rose",
        time: "10:30",
        title: "Pat @ Sequoia: where's the term sheet redline?",
        chip: { label: "investor", tone: "rose" },
      },
      {
        dot: "blue",
        time: "09:15",
        title: "Saritha: board deck approved, sending tomorrow",
        chip: { label: "team", tone: "blue" },
      },
      {
        dot: "grey",
        time: "1d",
        title: "Anjali: can we ship audio briefing in v1?",
        chip: { label: "product", tone: "grey" },
      },
    ],
  },
  {
    title: "decisions",
    meta: "1 due",
    rows: [
      {
        dot: "violet",
        time: "3d",
        title: "accept Sequoia term sheet at $40M valuation?",
        chip: { label: "high stakes", tone: "violet" },
      },
    ],
  },
  {
    title: "calendar",
    meta: "2 today",
    rows: [
      {
        dot: "grey",
        time: "14:00",
        title: "founder sync with Saritha",
        chip: { label: "recurring", tone: "emerald" },
      },
      {
        dot: "blue",
        time: "16:30",
        title: "customer call with Acme CTO",
        chip: { label: "external", tone: "blue" },
      },
    ],
  },
  {
    title: "okrs",
    meta: "q3 · week 4 of 13",
    rows: [
      {
        dot: "amber",
        time: "24%",
        title: "reach 50 paying trial users — at 12 of 50",
        chip: { label: "behind", tone: "amber" },
      },
      {
        dot: "grey",
        time: "60%",
        title: "ship v1 with command palette + audio briefing",
        chip: { label: "on track", tone: "emerald" },
      },
    ],
  },
  {
    title: "email",
    meta: "5 of 247",
    rows: [
      {
        dot: "blue",
        time: "08:14",
        title: "Term sheet redline from Sequoia legal",
        chip: { label: "investor", tone: "blue" },
      },
      {
        dot: "blue",
        time: "07:22",
        title: "Customer churn alert — Acme downgraded",
        chip: { label: "revenue", tone: "blue" },
      },
    ],
  },
];

function DashSectionBlock({ section }: { section: Section }) {
  return (
    <div
      className="mb-3 overflow-hidden rounded-[8px] border"
      style={{
        background: "var(--cred-card-bg)",
        borderColor: "var(--cred-border)",
      }}
    >
      <div
        className="flex items-center justify-between border-b px-5 py-3"
        style={{ borderColor: "var(--cred-border-soft)" }}
      >
        <div className="flex items-center gap-2 text-[14px] font-medium tracking-[-0.01em]">
          <span aria-hidden="true" style={{ color: "var(--cred-flourish)" }}>
            ✦
          </span>
          <span className="cred-ui-lower">{section.title}</span>
        </div>
        <div
          className="cred-ui-lower text-[11.5px] tabular-nums"
          style={{ color: "var(--cred-text-meta)" }}
        >
          {section.meta}
        </div>
      </div>
      {section.rows.map((row, idx) => (
        <div
          key={idx}
          className="flex items-center gap-3 px-5 py-3"
          style={{
            borderTop:
              idx === 0
                ? "none"
                : "1px solid var(--cred-border-soft)",
          }}
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: DOT_BG[row.dot] }}
          />
          <span
            className="min-w-[42px] text-[11.5px] tabular-nums"
            style={{ color: "var(--cred-text-meta)" }}
          >
            {row.time}
          </span>
          <span className="flex-1 text-[13.5px] text-[var(--cred-text-primary)]">
            {row.title}
          </span>
          <span
            className="cred-ui-lower inline-flex rounded-[3px] px-2 py-[3px] text-[11px] font-medium tracking-[0.02em]"
            style={{
              background: CHIP_STYLE[row.chip.tone].bg,
              color: CHIP_STYLE[row.chip.tone].fg,
            }}
          >
            {row.chip.label}
          </span>
        </div>
      ))}
    </div>
  );
}

export function DashboardSnapshot() {
  return (
    <div
      className="overflow-hidden rounded-[12px] border"
      style={{
        background: "var(--cred-card-bg)",
        borderColor: "var(--cred-border)",
        boxShadow: "0 8px 32px rgba(26, 22, 20, 0.08)",
      }}
    >
      {/* Browser-frame chrome */}
      <div
        className="flex items-center gap-4 border-b px-5 py-3"
        style={{
          background: "var(--cred-page-bg)",
          borderColor: "var(--cred-border)",
        }}
      >
        <div className="flex gap-1.5" aria-hidden="true">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: "#d4cbb8" }}
          />
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: "#e5dcc4" }}
          />
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: "#ece5d0" }}
          />
        </div>
        <div
          className="flex-1 rounded border px-3 py-1 text-center font-mono text-[11.5px]"
          style={{
            background: "var(--cred-card-bg)",
            borderColor: "var(--cred-border)",
            color: "var(--cred-text-meta)",
          }}
        >
          wingman.app/dashboard
        </div>
      </div>

      {/* Inside-frame dashboard content */}
      <div className="px-9 py-8">
        <h3 className="text-[28px] font-light tracking-[-0.03em]">
          <span className="cred-ui-lower">good morning, </span>
          <span style={{ fontWeight: 400 }}>ajit</span>
          <span className="cred-ui-lower">.</span>
        </h3>
        <p
          className="cred-ui-lower mt-1 mb-5 text-[14px]"
          style={{ color: "var(--cred-text-secondary)" }}
        >
          3 things need you. rest can wait.
        </p>

        <VoiceDigestPlayer decorative />

        {SECTIONS.map((s) => (
          <DashSectionBlock key={s.title} section={s} />
        ))}
      </div>
    </div>
  );
}
