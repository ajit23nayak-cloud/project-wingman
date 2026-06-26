"use client";

// Wingman homepage (Commit 17). Cred + Newspaper visual reset, full
// rewrite of the prior landing page (page.module.css deleted alongside
// this rewrite). Reference: wingman-homepage-prototype.html v4 (locked
// by Ajit). All design tokens come from globals.css (Commit 15).
//
// Form posts to /api/waitlist — body shape MUST include `honeypot` (must
// be "") + `formOpenedAt` (numeric epoch ms set when form first mounts)
// per the bot defense in src/app/api/waitlist/route.ts. The spec missed
// these two fields; the route returns rate_limited if they're absent.
//
// Hybrid lowercase rule (per Commit 15 + Commit 17 spec):
//   - Title Case literal: hero h1, section h2 titles, step/feature h3
//     titles, FAQ Q headers, cohort card title, final CTA title
//   - Lowercase via cred-ui-lower OR literal: nav links/CTA, eyebrows,
//     button labels, chip text, meta, form labels, dashboard greeting
//   - Sentence case (literal): hero sub, section subs, step bodies,
//     feature bodies, FAQ answer bodies

import { useEffect, useRef, useState } from "react";
import { DashboardSnapshot } from "@/components/DashboardSnapshot";

const ERROR_COPY: Record<string, string> = {
  invalid_email: "Please enter a valid email address.",
  company_required: "Company name is required.",
  response_required: "Tell me what's on your mind — even one line.",
  response_too_long: "Keep it under 500 characters.",
  rate_limited:
    "Something looked off with that submission. Try again in a moment.",
  server_error: "Something went wrong on our side. Try again shortly.",
};

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success" }
  | { kind: "error"; code: string };

const NAV_LINKS = [
  { href: "#dashboard", label: "see it" },
  { href: "#how", label: "how it works" },
  { href: "#proof", label: "founders" },
  { href: "#faq", label: "faq" },
];

const STEPS = [
  {
    n: "01",
    title: "Connect Your Sources",
    body:
      "Gmail, Slack, Calendar, Notion. One-click OAuth, no migrations, no IT involvement. You stay in control — revoke anytime from settings.",
    meta: "~90 seconds",
  },
  {
    n: "02",
    title: "We Read Everything Overnight",
    body:
      "Your last 30 days of email get classified. Your calendar gets prep-noted. Your Slack gets summarised. You wake up to the dashboard, populated.",
    meta: "runs while you sleep",
  },
  {
    n: "03",
    title: "Operate From One Surface",
    body:
      "One page, every morning. The 3 things that need you, the rest sorted. Drafts in your voice. Decisions logged. Cadence kept.",
    meta: "5 min, daily",
  },
];

const FEATURES = [
  {
    icon: "📥",
    title: "Inbox Triage",
    body:
      "Urgent / important / fyi / archive — classified the moment they land. You only see what needs you.",
    grad: "var(--cred-grad-peach)",
  },
  {
    icon: "✦",
    title: "Decision Log",
    body:
      "Every choice you make gets logged with context. So when you ask \"why did I do that?\" three months from now, you have an answer.",
    grad: "var(--cred-grad-mint)",
  },
  {
    icon: "🤝",
    title: "Relationship Cadence",
    body:
      "Wingman flags the investors, advisors, customers you haven't touched in too long — before they go cold.",
    grad: "var(--cred-grad-blush)",
  },
  {
    icon: "📊",
    title: "OKR Tracker",
    body:
      "Your quarterly OKRs, pulled live from Notion. Behind / on-track / ahead, surfaced every morning so you can't hide from them.",
    grad: "var(--cred-grad-lavender)",
  },
  {
    icon: "📅",
    title: "Calendar Prep",
    body:
      "Every meeting comes with auto-generated context: who you're meeting, what you last discussed, what they care about.",
    grad: "var(--cred-grad-warm)",
  },
  {
    icon: "✉️",
    title: "Drafts in Your Voice",
    body:
      "Wingman learns how you write. Drafts that sound like you, not like a chatbot. 9 of 10 send without edits.",
    grad: "var(--cred-grad-peach)",
  },
  {
    icon: "🎧",
    title: "Voice Digest",
    body:
      "A 5-minute audio briefing every morning, covering what landed overnight, what needs you today, and your calendar. Listen while you make coffee.",
    grad: "var(--cred-grad-lavender)",
  },
  {
    icon: "⚡",
    title: "Today's Signal",
    body:
      "One sentence at the top of your dashboard, every morning. The ONE thing that matters most today, surfaced from everything Wingman read overnight.",
    grad: "var(--cred-grad-mint)",
  },
];

const FAQS = [
  {
    q: "What Does Wingman Cost?",
    a: "Trial cohort is free during the trial period. We'll share paid pricing before public launch — cohort members will get founder pricing locked in for the life of their account.",
  },
  {
    q: "Is My Data Safe?",
    a: "OAuth-only access (no passwords stored), end-to-end encryption, your data is never used to train any model, and you can revoke Wingman's access from Gmail/Slack/Notion in one click. We read your data — we don't sell it, share it, or look at it ourselves.",
  },
  {
    q: "Do I Need to Be Technical?",
    a: "No. Setup is one-click OAuth, no installation, no API keys, no configuration. If you can sign in to Google, you can use Wingman.",
  },
  {
    q: "What If I Don't Like It?",
    a: "Disconnect any source in one click. Delete your account from settings. We keep nothing. (And if you tell us why, we'll fix it. We ship daily.)",
  },
  {
    q: "Can I Use My Existing Email and Slack?",
    a: "Yes — we work with what you have. Gmail, Google Workspace, Slack (any workspace), Notion, Google Calendar. Outlook and Microsoft Teams support coming Q4 2026.",
  },
];

function CohortForm() {
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [overload, setOverload] = useState("");
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });
  // Mount-time epoch so the route's bot timing gate (>=1.5s) passes for
  // human users. honeypot stays empty for humans; bots that auto-fill it
  // trip the rate-limited masquerade.
  const formOpenedAtRef = useRef<number>(0);
  const [honeypot, setHoneypot] = useState("");
  useEffect(() => {
    formOpenedAtRef.current = Date.now();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submit.kind === "submitting") return;
    setSubmit({ kind: "submitting" });
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          company: company.trim(),
          overload_response: overload.trim(),
          honeypot,
          formOpenedAt: formOpenedAtRef.current,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setSubmit({
          kind: "error",
          code: data.error ?? "server_error",
        });
      } else {
        setSubmit({ kind: "success" });
      }
    } catch {
      setSubmit({ kind: "error", code: "server_error" });
    }
  };

  if (submit.kind === "success") {
    return (
      <div
        className="mt-9 max-w-[540px] rounded-[12px] border px-8 py-10 text-center"
        style={{
          background: "rgba(245, 240, 230, 0.06)",
          borderColor: "rgba(245, 240, 230, 0.18)",
        }}
      >
        <div
          className="mb-3 text-[32px]"
          style={{ color: "var(--cred-flourish)" }}
        >
          ✦
        </div>
        <p
          className="text-[18px] font-light"
          style={{ color: "var(--cred-page-bg)" }}
        >
          Got it. We&apos;ll be in touch within 24 hours.
        </p>
      </div>
    );
  }

  const errorMsg =
    submit.kind === "error"
      ? ERROR_COPY[submit.code] ?? ERROR_COPY.server_error
      : null;

  return (
    <form
      onSubmit={handleSubmit}
      className="relative z-[2] mt-9 grid max-w-[540px] gap-4"
      noValidate
    >
      {/* Honeypot — hidden from humans, bots auto-fill */}
      <input
        type="text"
        name="company_url"
        value={honeypot}
        onChange={(e) => setHoneypot(e.target.value)}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        style={{
          position: "absolute",
          left: "-9999px",
          width: 1,
          height: 1,
        }}
      />

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="cohort-email"
          className="cred-ui-lower text-[11.5px] font-medium tracking-[0.02em]"
          style={{ color: "#d4cbb8" }}
        >
          your email
        </label>
        <input
          id="cohort-email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@yourcompany.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="cred-form-input w-full rounded-[6px] px-3.5 py-3 text-[14px]"
          style={{
            background: "rgba(245, 240, 230, 0.06)",
            border: "1px solid rgba(245, 240, 230, 0.18)",
            color: "var(--cred-page-bg)",
            WebkitTextFillColor: "var(--cred-page-bg)",
          }}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="cohort-company"
          className="cred-ui-lower text-[11.5px] font-medium tracking-[0.02em]"
          style={{ color: "#d4cbb8" }}
        >
          your company
        </label>
        <input
          id="cohort-company"
          name="company"
          type="text"
          required
          autoComplete="organization"
          placeholder="what you're building"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          className="cred-form-input w-full rounded-[6px] px-3.5 py-3 text-[14px]"
          style={{
            background: "rgba(245, 240, 230, 0.06)",
            border: "1px solid rgba(245, 240, 230, 0.18)",
            color: "var(--cred-page-bg)",
            WebkitTextFillColor: "var(--cred-page-bg)",
          }}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="cohort-response"
          className="cred-ui-lower text-[11.5px] font-medium tracking-[0.02em]"
          style={{ color: "#d4cbb8" }}
        >
          what&apos;s overwhelming you most right now?
        </label>
        <textarea
          id="cohort-response"
          name="overload_response"
          required
          maxLength={500}
          placeholder="one or two lines is plenty. we read every single one."
          value={overload}
          onChange={(e) => setOverload(e.target.value)}
          className="cred-form-input w-full resize-y rounded-[6px] px-3.5 py-3 text-[14px] leading-[1.5]"
          style={{
            background: "rgba(245, 240, 230, 0.06)",
            border: "1px solid rgba(245, 240, 230, 0.18)",
            color: "var(--cred-page-bg)",
            WebkitTextFillColor: "var(--cred-page-bg)",
            minHeight: 86,
          }}
        />
        <span
          className="cred-ui-lower mt-0.5 text-[11px]"
          style={{ color: "#78716c" }}
        >
          500 characters max. signal &gt; polish.
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={submit.kind === "submitting"}
          className="cred-ui-lower inline-flex items-center gap-2 rounded-[8px] border px-6 py-3 text-[14px] font-medium tracking-[0.01em] transition-transform hover:-translate-y-[1px] disabled:opacity-60"
          style={{
            background: "var(--cred-page-bg)",
            color: "var(--cred-text-primary)",
            borderColor: "var(--cred-page-bg)",
          }}
        >
          {submit.kind === "submitting"
            ? "applying…"
            : "apply to the trial cohort"}
          <span>→</span>
        </button>
        <span
          className="cred-ui-lower text-[12px]"
          style={{ color: "#9b9389" }}
        >
          90 seconds · response within 24 hours
        </span>
      </div>

      {errorMsg && (
        <p
          className="text-[13px]"
          style={{ color: "#ffcad4" }}
        >
          {errorMsg}
        </p>
      )}
    </form>
  );
}

function PrimaryBtn({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className="cred-ui-lower inline-flex items-center gap-2 rounded-[8px] border px-5 py-3 text-[14px] font-medium tracking-[0.01em] transition-transform hover:-translate-y-[1px]"
      style={{
        background: "var(--cred-text-primary)",
        color: "var(--cred-page-bg)",
        borderColor: "var(--cred-text-primary)",
      }}
    >
      {children}
    </a>
  );
}

function SecondaryBtn({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className="cred-ui-lower inline-flex items-center gap-2 rounded-[8px] border px-5 py-3 text-[14px] font-medium tracking-[0.01em] transition-transform hover:-translate-y-[1px]"
      style={{
        background: "var(--cred-card-bg)",
        color: "var(--cred-text-primary)",
        borderColor: "var(--cred-border)",
      }}
    >
      {children}
    </a>
  );
}

function SectionEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="cred-ui-lower mb-4 inline-flex items-center gap-2 text-[12px] font-medium tracking-[0.04em]"
      style={{ color: "var(--cred-text-meta)" }}
    >
      <span aria-hidden="true" style={{ color: "var(--cred-flourish)" }}>
        ✦
      </span>
      {children}
    </div>
  );
}

export default function LandingPage() {
  return (
    <>
      {/* Sticky nav */}
      <nav
        className="sticky top-0 z-50 border-b backdrop-blur"
        style={{
          background: "rgba(250, 247, 242, 0.92)",
          borderColor: "var(--cred-border)",
        }}
      >
        <div className="mx-auto max-w-[1120px] px-8">
          <div className="flex items-center justify-between py-[18px]">
            <div className="cred-ui-lower flex items-center gap-2.5 text-[16px] font-medium tracking-[-0.01em]">
              <span
                aria-hidden="true"
                className="text-[14px]"
                style={{ color: "var(--cred-flourish)" }}
              >
                ✦
              </span>
              wingman
            </div>
            <div className="flex items-center gap-7 text-[13.5px]">
              {NAV_LINKS.map((l) => (
                <a
                  key={l.href}
                  href={l.href}
                  className="cred-ui-lower transition-colors"
                  style={{ color: "var(--cred-text-secondary)" }}
                >
                  {l.label}
                </a>
              ))}
              <a
                href="#cohort"
                className="cred-ui-lower rounded-[6px] px-4 py-2 font-medium"
                style={{
                  background: "var(--cred-text-primary)",
                  color: "var(--cred-page-bg)",
                }}
              >
                join cohort
              </a>
            </div>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section
        className="border-b"
        style={{
          padding: "88px 0 64px",
          borderColor: "var(--cred-border-soft)",
        }}
      >
        <div className="mx-auto max-w-[1120px] px-8">
          <h1
            className="mb-6 max-w-[820px] text-[56px] font-light leading-[1.05] tracking-[-0.035em]"
            style={{ textTransform: "lowercase" }}
          >
            Your Inbox Runs You.
            <br />
            <em
              className="font-normal not-italic"
              style={{ fontStyle: "italic", color: "var(--cred-text-secondary)" }}
            >
              Let Your AI Chief of Staff
            </em>{" "}
            <span
              className="font-normal"
              style={{ color: "var(--cred-flourish)" }}
            >
              Run It
            </span>{" "}
            for You.
          </h1>
          <p
            className="mb-9 max-w-[640px] text-[18px] leading-[1.55]"
            style={{ color: "var(--cred-text-secondary)" }}
          >
            Wingman reads every email, Slack DM, calendar invite, Notion page,
            and decision you&apos;ve made — then surfaces only what actually
            needs you. So you stop drowning, and start operating.
          </p>
          <div className="mb-12 flex flex-wrap items-center gap-3.5">
            <PrimaryBtn href="#cohort">
              apply to the trial cohort <span className="text-base">→</span>
            </PrimaryBtn>
            <SecondaryBtn href="#dashboard">see the dashboard</SecondaryBtn>
            <span
              className="cred-ui-lower text-[12.5px]"
              style={{ color: "var(--cred-text-meta)" }}
            >
              no credit card. apply in 90 seconds.
            </span>
          </div>

          {/* Hero stats: peach + mint + blush gradients */}
          <div className="grid max-w-[880px] grid-cols-1 gap-4 md:grid-cols-3">
            {[
              {
                label: "daily triage time",
                value: "5 min",
                meta: "down from ~90",
                grad: "var(--cred-grad-peach)",
                labelColor: "#6b4423",
              },
              {
                label: "voice-matched drafts",
                value: "9 of 10",
                meta: "land without edits",
                grad: "var(--cred-grad-mint)",
                labelColor: "#2c5d3f",
              },
              {
                label: "tools replaced",
                value: "8",
                meta: "one surface, instead of switching",
                grad: "var(--cred-grad-blush)",
                labelColor: "#7d3849",
              },
            ].map((s) => (
              <div
                key={s.label}
                className="flex min-h-[110px] flex-col justify-between rounded-[10px] px-6 pt-[22px] pb-[26px]"
                style={{ background: s.grad }}
              >
                <span
                  className="text-[10.5px] font-medium uppercase tracking-[0.12em] opacity-75"
                  style={{ color: s.labelColor }}
                >
                  {s.label}
                </span>
                <div>
                  <div
                    className="text-[32px] font-light leading-none tracking-[-0.04em] tabular-nums"
                    style={{ color: "var(--cred-text-primary)" }}
                  >
                    {s.value}
                  </div>
                  <div
                    className="cred-ui-lower mt-1 text-[11.5px]"
                    style={{ color: "var(--cred-text-secondary)" }}
                  >
                    {s.meta}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Dashboard preview */}
      <section
        id="dashboard"
        style={{
          padding: "80px 0 100px",
          background:
            "linear-gradient(180deg, var(--cred-page-bg) 0%, #f5f0e6 100%)",
        }}
      >
        <div className="mx-auto max-w-[1120px] px-8">
          <SectionEyebrow>the dashboard</SectionEyebrow>
          <h2
            className="mb-4 max-w-[700px] text-[38px] font-light leading-[1.15] tracking-[-0.025em]"
          >
            This Is What You Wake Up To.
          </h2>
          <p
            className="mb-12 max-w-[580px] text-[16px]"
            style={{ color: "var(--cred-text-secondary)" }}
          >
            No demo video, no marketing screenshot — an actual render of what
            your dashboard looks like at 7am every morning. Yours will be
            populated with your real signal, not these examples.
          </p>

          <DashboardSnapshot />

          <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-2">
            {[
              {
                title: "free 30-day classification",
                body:
                  "We classify your last 30 days of email free, no commitment. See what you'd be getting before you decide anything.",
              },
              {
                title: "setup in 90 seconds",
                body:
                  "Connect Gmail. That's it. By the time your coffee's brewed, Wingman's already classifying.",
              },
            ].map((a) => (
              <div
                key={a.title}
                className="rounded-[8px] border p-5"
                style={{
                  background: "var(--cred-card-bg)",
                  borderColor: "var(--cred-border)",
                }}
              >
                <div
                  className="cred-ui-lower mb-1 text-[14px] font-medium"
                  style={{ color: "var(--cred-text-primary)" }}
                >
                  {a.title}
                </div>
                <div
                  className="text-[12.5px] leading-[1.5]"
                  style={{ color: "var(--cred-text-secondary)" }}
                >
                  {a.body}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section
        id="how"
        className="border-b"
        style={{
          padding: "96px 0",
          borderColor: "var(--cred-border-soft)",
        }}
      >
        <div className="mx-auto max-w-[1120px] px-8">
          <SectionEyebrow>how it works</SectionEyebrow>
          <h2 className="mb-4 max-w-[700px] text-[38px] font-light leading-[1.15] tracking-[-0.025em]">
            Three Steps. Ten Minutes. Yours Forever.
          </h2>
          <p
            className="max-w-[580px] text-[16px]"
            style={{ color: "var(--cred-text-secondary)" }}
          >
            No manual to read. No workflow to design. Just connect your inbox,
            your Slack, your calendar — Wingman figures out the rest.
          </p>

          <div className="mt-10 grid grid-cols-1 gap-8 md:grid-cols-3">
            {STEPS.map((step) => (
              <div
                key={step.n}
                className="rounded-[12px] border p-7"
                style={{
                  background: "var(--cred-card-bg)",
                  borderColor: "var(--cred-border)",
                }}
              >
                <div
                  className="mb-4 text-[44px] font-light leading-none tracking-[-0.04em] tabular-nums"
                  style={{ color: "var(--cred-flourish)" }}
                >
                  {step.n}
                </div>
                <h3
                  className="cred-ui-lower mb-2.5 text-[18px] font-medium tracking-[-0.01em]"
                >
                  {step.title}
                </h3>
                <p
                  className="text-[14px] leading-[1.55]"
                  style={{ color: "var(--cred-text-secondary)" }}
                >
                  {step.body}
                </p>
                <div
                  className="cred-ui-lower mt-3.5 border-t border-dashed pt-3.5 text-[12px] tabular-nums"
                  style={{
                    borderColor: "var(--cred-border)",
                    color: "var(--cred-text-meta)",
                  }}
                >
                  {step.meta}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section
        id="features"
        className="border-b"
        style={{
          padding: "96px 0",
          borderColor: "var(--cred-border-soft)",
        }}
      >
        <div className="mx-auto max-w-[1120px] px-8">
          <SectionEyebrow>what you get</SectionEyebrow>
          <h2 className="mb-4 max-w-[820px] text-[38px] font-light leading-[1.15] tracking-[-0.025em]">
            Eight Things Wingman Does, So You Don&apos;t Have To.
          </h2>

          <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-2">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="relative overflow-hidden rounded-[12px] border p-8"
                style={{
                  background: "var(--cred-card-bg)",
                  borderColor: "var(--cred-border)",
                }}
              >
                <span
                  aria-hidden="true"
                  className="absolute right-0 top-0"
                  style={{
                    width: 120,
                    height: 120,
                    background: f.grad,
                    opacity: 0.4,
                    borderBottomLeftRadius: 120,
                  }}
                />
                <div className="relative z-[1] mb-4 text-[24px]">{f.icon}</div>
                <h3
                  className="cred-ui-lower relative z-[1] mb-2 text-[18px] font-medium tracking-[-0.01em]"
                >
                  {f.title}
                </h3>
                <p
                  className="relative z-[1] text-[14px] leading-[1.6]"
                  style={{ color: "var(--cred-text-secondary)" }}
                >
                  {f.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Social proof */}
      <section
        id="proof"
        className="border-y"
        style={{
          padding: "96px 0",
          background: "var(--cred-card-bg)",
          borderColor: "var(--cred-border)",
        }}
      >
        <div className="mx-auto max-w-[1120px] px-8">
          <SectionEyebrow>founders inside</SectionEyebrow>
          <h2 className="mb-12 max-w-[820px] text-[38px] font-light leading-[1.15] tracking-[-0.025em]">
            Multiple Founders Already Operate From Wingman Daily.
          </h2>
          <div className="grid grid-cols-1 gap-8 text-center md:grid-cols-3">
            {[
              { num: "multiple", label: "founders shipping daily" },
              { num: "5 min", label: "average morning ritual" },
              { num: "4", label: "sources, one surface" },
            ].map((p) => (
              <div key={p.label}>
                <div
                  className="mb-2 text-[48px] font-light leading-none tracking-[-0.04em] tabular-nums"
                  style={{ color: "var(--cred-text-primary)" }}
                >
                  {p.num}
                </div>
                <div
                  className="cred-ui-lower text-[12px] tracking-[0.04em]"
                  style={{ color: "var(--cred-text-meta)" }}
                >
                  {p.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Cohort form */}
      <section id="cohort" style={{ padding: "96px 0" }}>
        <div className="mx-auto max-w-[1120px] px-8">
          <div
            className="relative overflow-hidden rounded-[16px] px-12 py-14"
            style={{
              background: "var(--cred-text-primary)",
              color: "var(--cred-page-bg)",
            }}
          >
            <span
              aria-hidden="true"
              className="absolute rounded-full"
              style={{
                top: -80,
                right: -80,
                width: 320,
                height: 320,
                background: "var(--cred-grad-peach)",
                opacity: 0.15,
              }}
            />
            <div
              className="relative z-[1] mb-4 text-[11px] font-semibold uppercase tracking-[0.12em]"
              style={{ color: "var(--cred-flourish)" }}
            >
              trial cohort
            </div>
            <h2
              className="relative z-[1] mb-4 max-w-[580px] text-[40px] font-light leading-[1.1] tracking-[-0.03em]"
              style={{ textTransform: "none" }}
            >
              Join the Founders Shaping{" "}
              <span style={{ color: "var(--cred-flourish)" }}>
                Wingman v1.
              </span>
            </h2>
            <p
              className="relative z-[1] mb-8 max-w-[540px] text-[16px] leading-[1.6]"
              style={{ color: "#d4cbb8" }}
            >
              Trial cohort members get early access, direct line to me on
              Slack, and shape what Wingman becomes. You&apos;ll be operating
              from one surface within a week.
            </p>

            <CohortForm />
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section
        id="faq"
        className="border-t"
        style={{ padding: "96px 0", borderColor: "var(--cred-border-soft)" }}
      >
        <div className="mx-auto max-w-[1120px] px-8">
          <SectionEyebrow>questions you might have</SectionEyebrow>
          <h2 className="mb-10 text-[38px] font-light leading-[1.15] tracking-[-0.025em]">
            Questions You Might Have.
          </h2>
          <div className="max-w-[760px]">
            {FAQS.map((f, i) => (
              <div
                key={i}
                className="border-t py-6"
                style={{
                  borderColor: "var(--cred-border)",
                  borderBottom:
                    i === FAQS.length - 1
                      ? "1px solid var(--cred-border)"
                      : undefined,
                }}
              >
                <div className="mb-2.5 text-[16px] font-medium tracking-[-0.005em]">
                  {f.q}
                </div>
                <p
                  className="text-[14px] leading-[1.6]"
                  style={{ color: "var(--cred-text-secondary)" }}
                >
                  {f.a}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section
        className="border-t text-center"
        style={{
          padding: "96px 0 112px",
          borderColor: "var(--cred-border-soft)",
          background:
            "linear-gradient(180deg, var(--cred-page-bg) 0%, #f5f0e6 100%)",
        }}
      >
        <div className="mx-auto max-w-[1120px] px-8">
          <h2 className="mx-auto mb-4 max-w-[720px] text-[44px] font-light leading-[1.1] tracking-[-0.03em]">
            Stop Drowning in Your Inbox.
            <br />
            Start Operating From One Surface.
          </h2>
          <p
            className="mx-auto mb-9 max-w-[520px] text-[16px]"
            style={{ color: "var(--cred-text-secondary)" }}
          >
            90 seconds to apply, 24 hours to hear back. You&apos;ll be
            operating from one surface within a week.
          </p>
          <div className="flex flex-wrap justify-center gap-3.5">
            <PrimaryBtn href="#cohort">
              apply to the trial cohort <span className="text-base">→</span>
            </PrimaryBtn>
            <SecondaryBtn href="#dashboard">see the dashboard first</SecondaryBtn>
          </div>
          <p
            className="cred-ui-lower mt-5 text-[12px]"
            style={{ color: "var(--cred-text-meta)" }}
          >
            no credit card. cancel anytime. revoke access in one click.
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer
        className="border-t"
        style={{
          padding: "40px 0",
          background: "var(--cred-card-bg)",
          borderColor: "var(--cred-border)",
        }}
      >
        <div className="mx-auto max-w-[1120px] px-8">
          <div
            className="cred-ui-lower flex flex-wrap items-center justify-between gap-2 text-[12px]"
            style={{ color: "var(--cred-text-meta)" }}
          >
            <div>
              <span
                aria-hidden="true"
                style={{ color: "var(--cred-flourish)" }}
              >
                ✦
              </span>{" "}
              wingman · an ai chief of staff for founders
            </div>
            <div>© 2026 · privacy · terms · contact</div>
          </div>
        </div>
      </footer>
    </>
  );
}
