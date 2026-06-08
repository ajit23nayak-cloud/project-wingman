"use client";

// Onboarding framework-matching assessment. Per MH_UI_SPEC.md L127-181 and
// Tab 2's 16:50 UTC lock:
//   - 6 forced-choice questions, 3 options each
//   - User ranks each option 1/2/3 (most-like-me = 3 points, least = 1)
//   - Per-option 1/2/3 radio cluster UI (option (ii) from pushback flag C)
//   - Client validates "exactly one rank per row" before enabling Next
//   - Server scores (we don't trust the client)
//   - Skip available on every screen; 24h re-nudge gated by users.mh_assessment_*
//     columns set by /api/mh/assessment/skip

import { useState } from "react";
import Link from "next/link";
import {
  ASSESSMENT_QUESTIONS,
  type Framework,
  type QuestionRanking,
} from "@/lib/mh/assessment";

type Rank = 1 | 2 | 3;
type AnswerState = Record<number, Partial<Record<Framework, Rank>>>;

function isComplete(qIndex: number, answers: AnswerState): boolean {
  const q = ASSESSMENT_QUESTIONS[qIndex];
  const a = answers[q.id] ?? {};
  const ranksUsed = new Set<Rank>();
  for (const opt of q.options) {
    const r = a[opt.framework];
    if (!r) return false;
    if (ranksUsed.has(r)) return false;
    ranksUsed.add(r);
  }
  return ranksUsed.size === 3;
}

function buildRankingsPayload(answers: AnswerState): QuestionRanking[] {
  return ASSESSMENT_QUESTIONS.map((q) => ({
    questionId: q.id,
    ranks: q.options.map((opt) => ({
      framework: opt.framework,
      rank: answers[q.id]![opt.framework]! as 1 | 2 | 3,
    })),
  }));
}

export function AssessmentView() {
  const [qIndex, setQIndex] = useState(0);
  const [answers, setAnswers] = useState<AnswerState>({});
  const [submitting, setSubmitting] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = ASSESSMENT_QUESTIONS.length;
  const question = ASSESSMENT_QUESTIONS[qIndex];
  const canAdvance = isComplete(qIndex, answers);
  const isLast = qIndex === total - 1;

  const setRank = (framework: Framework, rank: Rank) => {
    setAnswers((prev) => {
      const current = { ...(prev[question.id] ?? {}) };
      // If this rank is already assigned to another framework on this
      // question, swap them so each rank stays unique.
      const existingFrameworkAtRank = (
        Object.keys(current) as Framework[]
      ).find((f) => current[f] === rank);
      if (existingFrameworkAtRank && existingFrameworkAtRank !== framework) {
        const oldRank = current[framework];
        current[existingFrameworkAtRank] = oldRank;
      }
      current[framework] = rank;
      return { ...prev, [question.id]: current };
    });
  };

  const handleNext = () => {
    setError(null);
    if (!canAdvance) return;
    if (!isLast) {
      setQIndex((i) => i + 1);
      return;
    }
    void handleSubmit();
  };

  const handleBack = () => {
    setError(null);
    setQIndex((i) => Math.max(0, i - 1));
  };

  // Why `window.location.href` instead of router.push + mutate: Tab 2's
  // 17:35 UTC log entry caught a stale-cache bug on /assessment →
  // /dashboard nav — the original mutate+push pattern (same shape as the
  // f0ab301 OAuth re-auth fix) didn't actually refresh the dashboard's
  // useMe on sibling-route soft nav. Hard nav forces a full page mount,
  // useMe re-fetches from scratch, banner state reflects the just-written
  // mh_style or mh_assessment_skipped_at. Trade-off: a tiny flash of full
  // page reload vs. a stale banner that needs a manual refresh to clear.
  // We pick the reload — losing the banner-still-there UX bug is more
  // important than the SPA-feel of soft nav for a once-or-twice-per-user
  // flow.
  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/mh/assessment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rankings: buildRankingsPayload(answers) }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? `submit_${res.status}`);
        setSubmitting(false);
        return;
      }
      window.location.href = "/dashboard";
    } catch {
      setError("network_error");
      setSubmitting(false);
    }
  };

  const handleSkip = async () => {
    setSkipping(true);
    setError(null);
    try {
      const res = await fetch("/api/mh/assessment/skip", { method: "POST" });
      if (!res.ok) {
        setError("skip_failed");
        setSkipping(false);
        return;
      }
      window.location.href = "/dashboard";
    } catch {
      setError("network_error");
      setSkipping(false);
    }
  };

  const currentAnswer = answers[question.id] ?? {};

  return (
    <main className="min-h-screen bg-white text-gray-900">
      <nav className="border-b border-gray-200">
        <div className="max-w-2xl mx-auto px-6 py-5 flex items-center justify-between">
          <Link href="/dashboard" className="text-sm text-gray-600 hover:text-gray-900">
            ← Back to dashboard
          </Link>
          <button
            type="button"
            onClick={handleSkip}
            disabled={skipping || submitting}
            className="text-sm text-gray-500 hover:text-gray-700 disabled:opacity-50"
          >
            {skipping ? "Skipping…" : "Skip for now"}
          </button>
        </div>
      </nav>

      <div className="max-w-2xl mx-auto px-6 py-10">
        <div className="text-xs text-gray-500 uppercase tracking-wide">
          Personalize Wingman · Question {qIndex + 1} of {total}
        </div>
        <h1 className="mt-2 text-xl font-semibold leading-snug">
          {question.prompt}
        </h1>
        <p className="mt-3 text-sm text-gray-600">
          Rank these from most-like-me (3) to least-like-me (1). One rank per
          option.
        </p>

        <div className="mt-6 space-y-3">
          {question.options.map((opt) => (
            <div
              key={opt.framework}
              className="rounded-lg border border-gray-200 p-4"
            >
              <div className="text-sm text-gray-800">{opt.text}</div>
              <div className="mt-3 flex items-center gap-2">
                {([3, 2, 1] as Rank[]).map((rank) => {
                  const active = currentAnswer[opt.framework] === rank;
                  return (
                    <button
                      key={rank}
                      type="button"
                      onClick={() => setRank(opt.framework, rank)}
                      disabled={submitting || skipping}
                      aria-label={`Rank ${rank} ${
                        rank === 3 ? "most" : rank === 1 ? "least" : "middle"
                      } like me`}
                      className={`h-9 w-9 rounded-full border text-sm font-medium transition disabled:opacity-50 ${
                        active
                          ? "bg-black text-white border-black"
                          : "bg-white text-gray-700 border-gray-300 hover:border-gray-500"
                      }`}
                    >
                      {rank}
                    </button>
                  );
                })}
                <span className="ml-2 text-xs text-gray-500">
                  {currentAnswer[opt.framework] === 3 && "most like me"}
                  {currentAnswer[opt.framework] === 2 && "middle"}
                  {currentAnswer[opt.framework] === 1 && "least like me"}
                </span>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-8 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={handleBack}
            disabled={qIndex === 0 || submitting || skipping}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Back
          </button>
          <button
            type="button"
            onClick={handleNext}
            disabled={!canAdvance || submitting || skipping}
            className="rounded-md bg-black text-white px-4 py-1.5 text-sm font-medium hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting
              ? "Saving…"
              : isLast
                ? "See my style"
                : "Next"}
          </button>
        </div>

        {error && (
          <p className="mt-4 text-sm text-red-600">
            Something went wrong ({error}). Try again, or skip for now.
          </p>
        )}
      </div>
    </main>
  );
}
