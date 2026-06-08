// Pre-LLM regex screen for safety triggers. Layer 1 of the defense-in-depth
// model per Tab 2 01:05 UTC lock: this catches obvious phrases BEFORE we
// hit the LLM, so we can short-circuit + log without paying for a Gemini
// call. Layer 2 is the SAFETY block in chatPrompt.ts which the LLM honors
// when phrases evade the regex.
//
// Pattern source: patterns.json, compiled once at module load. Substring
// match, case-insensitive. False positives are acceptable — surfacing the
// escalation script on a borderline phrase is a feature, not a bug; the
// founder can dismiss and continue.

import patterns from "./patterns.json";

export type SafetyDetectionLayer = "regex" | "llm" | "none";
export type SafetyCategory =
  | "ideation"
  | "abuse"
  | "severe_symptoms"
  | "clinical_diagnosis";

export type ScreenResult =
  | { triggered: false }
  | {
      triggered: true;
      layer: "regex";
      category: SafetyCategory;
      matched: string;
    };

const CATEGORIES: SafetyCategory[] = [
  "ideation",
  "abuse",
  "severe_symptoms",
  "clinical_diagnosis",
];

// Module-scope compile so we don't rebuild on every call. Each pattern goes
// through a tiny regex escape — the JSON entries are intended as literal
// substrings, not regexes (no need to support regex metachars in v0).
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const COMPILED: Record<SafetyCategory, RegExp[]> = (() => {
  const out: Record<SafetyCategory, RegExp[]> = {
    ideation: [],
    abuse: [],
    severe_symptoms: [],
    clinical_diagnosis: [],
  };
  for (const cat of CATEGORIES) {
    const list = (patterns as Record<string, unknown>)[cat];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (typeof raw !== "string") continue;
      out[cat].push(new RegExp(escapeRegex(raw), "i"));
    }
  }
  return out;
})();

export function screenForSafety(text: string): ScreenResult {
  if (!text || typeof text !== "string") return { triggered: false };
  for (const cat of CATEGORIES) {
    for (const re of COMPILED[cat]) {
      if (re.test(text)) {
        return {
          triggered: true,
          layer: "regex",
          category: cat,
          matched: re.source,
        };
      }
    }
  }
  return { triggered: false };
}
