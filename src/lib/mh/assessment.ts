// MH onboarding assessment — questions + scoring logic. Single source of
// truth: both the /assessment page (renders the prompts) and the
// /api/mh/assessment POST route (scores server-side, never trusts the
// client) import from here.
//
// Spec source: MH_UI_SPEC.md §"Onboarding framework-matching assessment"
// (L127-181). Tab 2 16:50 UTC lock confirms tie-break interpretation and
// the per-option 1/2/3 radio UI.

export type Framework = "operational" | "state" | "inquiry";

export type QuestionOption = {
  framework: Framework;
  text: string;
};

export type Question = {
  id: number; // 1..6
  prompt: string;
  options: [QuestionOption, QuestionOption, QuestionOption];
};

// Questions verbatim from MH_UI_SPEC.md L135-163. Order of options is fixed
// within each question; framework labels come from the spec's L166 mapping
// (A → Operational, B → State, C → Inquiry) which corresponds to the
// option order in the spec text.
export const ASSESSMENT_QUESTIONS: Question[] = [
  {
    id: 1,
    prompt: "After a tough meeting, my impulse is to...",
    options: [
      {
        framework: "operational",
        text: "Open a list of next actions and start working through them.",
      },
      {
        framework: "state",
        text: "Take a walk or change environment to reset.",
      },
      {
        framework: "inquiry",
        text: "Write down what I noticed about my own reactions.",
      },
    ],
  },
  {
    id: 2,
    prompt: "The kind of advice I find most useful sounds like...",
    options: [
      {
        framework: "operational",
        text: '"Here are the specific things to try this week."',
      },
      {
        framework: "state",
        text: '"Notice how your body and language are creating this."',
      },
      {
        framework: "inquiry",
        text: '"What are you assuming that might not be true?"',
      },
    ],
  },
  {
    id: 3,
    prompt: "When I'm spiraling on a problem, what usually breaks the loop is...",
    options: [
      {
        framework: "operational",
        text: "Making the problem smaller — break it into parts.",
      },
      {
        framework: "state",
        text: "Doing something physical that changes my state.",
      },
      {
        framework: "inquiry",
        text: "Asking 'is this actually true?' about whatever I'm telling myself.",
      },
    ],
  },
  {
    id: 4,
    prompt: "I keep returning to a reflection practice when it...",
    options: [
      {
        framework: "operational",
        text: "Helps me execute better the next day.",
      },
      {
        framework: "state",
        text: "Helps me feel better and more grounded.",
      },
      {
        framework: "inquiry",
        text: "Helps me see something about myself I couldn't see before.",
      },
    ],
  },
  {
    id: 5,
    prompt: "Late at night, the thoughts that keep me up are usually...",
    options: [
      {
        framework: "operational",
        text: "Things I haven't done that I needed to do.",
      },
      {
        framework: "state",
        text: "Worries about how I came across or what's going to happen.",
      },
      {
        framework: "inquiry",
        text: "Questions about whether I'm building the right thing or being the right person.",
      },
    ],
  },
  {
    id: 6,
    prompt: "What does 'taking care of myself' mean to me right now?",
    options: [
      {
        framework: "operational",
        text: "Getting organized and not letting things slip.",
      },
      {
        framework: "state",
        text: "Managing my energy — sleep, exercise, time off.",
      },
      {
        framework: "inquiry",
        text: "Understanding why I keep doing the things I do.",
      },
    ],
  },
];

// Single question's rankings: each framework gets a rank of 1, 2, or 3.
// "Most-like-me" = 3 points (per spec L167).
export type QuestionRanking = {
  questionId: number;
  ranks: { framework: Framework; rank: 1 | 2 | 3 }[];
};

export type ValidationResult =
  | { ok: true; rankings: QuestionRanking[] }
  | { ok: false; error: string };

// Server-side validation of the POST body. Refuses ANY malformed shape — we
// never compute on partial data because tie-breaks become non-deterministic.
export function validateRankings(input: unknown): ValidationResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "body_not_object" };
  }
  const body = input as { rankings?: unknown };
  if (!Array.isArray(body.rankings)) {
    return { ok: false, error: "rankings_not_array" };
  }
  if (body.rankings.length !== ASSESSMENT_QUESTIONS.length) {
    return { ok: false, error: "rankings_length_mismatch" };
  }

  const seenIds = new Set<number>();
  const validated: QuestionRanking[] = [];

  for (const raw of body.rankings) {
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: "ranking_entry_not_object" };
    }
    const entry = raw as { questionId?: unknown; ranks?: unknown };
    if (typeof entry.questionId !== "number") {
      return { ok: false, error: "questionId_not_number" };
    }
    if (seenIds.has(entry.questionId)) {
      return { ok: false, error: "duplicate_questionId" };
    }
    const question = ASSESSMENT_QUESTIONS.find((q) => q.id === entry.questionId);
    if (!question) {
      return { ok: false, error: "unknown_questionId" };
    }
    seenIds.add(entry.questionId);

    if (!Array.isArray(entry.ranks) || entry.ranks.length !== 3) {
      return { ok: false, error: "ranks_must_be_length_3" };
    }

    const frameworks = new Set<Framework>();
    const ranks = new Set<number>();
    for (const r of entry.ranks) {
      if (!r || typeof r !== "object") {
        return { ok: false, error: "rank_entry_not_object" };
      }
      const rr = r as { framework?: unknown; rank?: unknown };
      if (
        rr.framework !== "operational" &&
        rr.framework !== "state" &&
        rr.framework !== "inquiry"
      ) {
        return { ok: false, error: "invalid_framework" };
      }
      if (rr.rank !== 1 && rr.rank !== 2 && rr.rank !== 3) {
        return { ok: false, error: "invalid_rank" };
      }
      frameworks.add(rr.framework as Framework);
      ranks.add(rr.rank as number);
    }
    if (frameworks.size !== 3) {
      return { ok: false, error: "frameworks_must_be_unique" };
    }
    if (ranks.size !== 3) {
      return { ok: false, error: "ranks_must_be_unique" };
    }

    validated.push({
      questionId: entry.questionId,
      ranks: entry.ranks as QuestionRanking["ranks"],
    });
  }

  return { ok: true, rankings: validated };
}

export type ScoringResult = {
  mhStyle: Framework;
  scores: Record<Framework, number>;
  tieBreakUsed: boolean;
};

// Scoring per spec L165-168:
//   - Sum the rank values per framework across all 6 questions
//   - Highest sum wins (max possible per framework = 18, min = 6)
//   - If tied at the top: break by sum of Q4 + Q6 ranks for the tied
//     frameworks (Tab 2 16:50 UTC lock confirms this interpretation)
//   - If still tied (rare 3-way at both stages): default to 'operational'
//
// Determinism matters here — the spec promises "Highest sum wins" but
// JavaScript Object.keys() order is reliable for string keys, and we
// iterate frameworks in a fixed array to avoid any platform variance.
const FRAMEWORK_ORDER: readonly Framework[] = [
  "operational",
  "state",
  "inquiry",
];

export function scoreRankings(rankings: QuestionRanking[]): ScoringResult {
  const totals: Record<Framework, number> = {
    operational: 0,
    state: 0,
    inquiry: 0,
  };
  for (const q of rankings) {
    for (const r of q.ranks) {
      totals[r.framework] += r.rank;
    }
  }

  const topScore = Math.max(...FRAMEWORK_ORDER.map((f) => totals[f]));
  const topFrameworks = FRAMEWORK_ORDER.filter((f) => totals[f] === topScore);

  if (topFrameworks.length === 1) {
    return {
      mhStyle: topFrameworks[0],
      scores: totals,
      tieBreakUsed: false,
    };
  }

  // Tie-break: sum Q4 + Q6 rank values for each tied framework.
  const tieBreak: Record<Framework, number> = {
    operational: 0,
    state: 0,
    inquiry: 0,
  };
  for (const q of rankings) {
    if (q.questionId !== 4 && q.questionId !== 6) continue;
    for (const r of q.ranks) {
      if (topFrameworks.includes(r.framework)) {
        tieBreak[r.framework] += r.rank;
      }
    }
  }

  const tieMax = Math.max(...topFrameworks.map((f) => tieBreak[f]));
  const tieWinners = topFrameworks.filter((f) => tieBreak[f] === tieMax);

  if (tieWinners.length === 1) {
    return {
      mhStyle: tieWinners[0],
      scores: totals,
      tieBreakUsed: true,
    };
  }

  // 3-way tie at both stages — extremely rare. Default to 'operational'
  // per spec ambiguity resolution.
  return {
    mhStyle: "operational",
    scores: totals,
    tieBreakUsed: true,
  };
}
