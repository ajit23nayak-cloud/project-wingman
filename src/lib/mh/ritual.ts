// Daily ritual — single source of truth. UI prompts, validation, and the
// tier-aware payload composition that splits a form submission into the
// (numeric_data, text_data) pair persisted to mh_sessions.
//
// IMPORTANT naming note (Tab 2 19:10 UTC clarification): `numeric_data` is
// misleadingly named. It's actually "structured / chartable data" — anything
// Wingman can aggregate or graph. Categorical strings like 'red'/'yellow'/
// 'green' and 'done'/'partial'/'missed' correctly live there alongside the
// 1-10 number scores. The real semantic boundary is:
//   numeric_data → structured + chartable (tier 2+ gate)
//   text_data    → free-text the user wrote (tier 3+ gate)
// Don't rename the column in v1 without coordinating with the correlation
// engine spec; just keep this comment as the reader's guide.

import type { MhStyle } from "@/lib/supabase/hooks";

export type RitualVariant = "operational" | "state" | "inquiry" | "mixed";
export type RitualType = "morning_ritual" | "evening_ritual";
export type StorageTier = 1 | 2 | 3 | 4;

// Variant resolution from a user's mh_style. State A users (style set) take
// the canonical path; states C/D (style null, skipped) take mixed.
export function variantFor(mhStyle: MhStyle | null): RitualVariant {
  return mhStyle ?? "mixed";
}

// Form field definitions per variant + type. These drive both the UI
// rendering on /daily and the validation on POST /api/mh/ritual. Adding a
// new field here updates both surfaces.

export type TextField = { key: string; kind: "text"; prompt: string };
export type NumberField = {
  key: string;
  kind: "number";
  prompt: string;
  min: number;
  max: number;
};
export type CategoricalField = {
  key: string;
  kind: "categorical";
  prompt: string;
  options: readonly string[];
};
export type RitualField = TextField | NumberField | CategoricalField;

const ENERGY_OPTIONS = ["red", "yellow", "green"] as const;
const MIP_SCORE_OPTIONS = ["done", "partial", "missed"] as const;

const SCORE_FIELDS: NumberField[] = [
  { key: "energy", kind: "number", prompt: "Energy today (1-10)", min: 1, max: 10 },
  { key: "focus", kind: "number", prompt: "Focus today (1-10)", min: 1, max: 10 },
  { key: "mood", kind: "number", prompt: "Mood today (1-10)", min: 1, max: 10 },
];

export const MORNING_FIELDS: Record<RitualVariant, RitualField[]> = {
  operational: [
    { key: "mip_1", kind: "text", prompt: "Most important problem #1" },
    {
      key: "mip_energy_1",
      kind: "categorical",
      prompt: "Energy on #1",
      options: ENERGY_OPTIONS,
    },
    { key: "mip_2", kind: "text", prompt: "Most important problem #2" },
    {
      key: "mip_energy_2",
      kind: "categorical",
      prompt: "Energy on #2",
      options: ENERGY_OPTIONS,
    },
    { key: "mip_3", kind: "text", prompt: "Most important problem #3" },
    {
      key: "mip_energy_3",
      kind: "categorical",
      prompt: "Energy on #3",
      options: ENERGY_OPTIONS,
    },
    {
      key: "intention",
      kind: "text",
      prompt: "What state do I need to be in today?",
    },
  ],
  state: [
    { key: "gratitude_1", kind: "text", prompt: "Gratitude #1" },
    { key: "gratitude_2", kind: "text", prompt: "Gratitude #2" },
    { key: "gratitude_3", kind: "text", prompt: "Gratitude #3" },
    {
      key: "priming_answer",
      kind: "text",
      prompt: "What's possible today that wasn't yesterday?",
    },
    { key: "focus", kind: "text", prompt: "Today's primary focus" },
    {
      key: "meaning",
      kind: "text",
      prompt: "What does today mean for me?",
    },
  ],
  inquiry: [
    {
      key: "thought",
      kind: "text",
      prompt: "What thought is most stressful right now?",
    },
    { key: "q1", kind: "text", prompt: "Is it true?" },
    { key: "q2", kind: "text", prompt: "Can you absolutely know it's true?" },
    {
      key: "q3",
      kind: "text",
      prompt: "How do you react when you believe that thought?",
    },
    { key: "q4", kind: "text", prompt: "Who would you be without it?" },
    {
      key: "turnaround",
      kind: "text",
      prompt:
        "What's the opposite of that thought? Is it as true or truer?",
    },
  ],
  mixed: [
    { key: "mip_1", kind: "text", prompt: "Most important problem #1" },
    { key: "mip_2", kind: "text", prompt: "Most important problem #2" },
    { key: "mip_3", kind: "text", prompt: "Most important problem #3" },
    {
      key: "priming_answer",
      kind: "text",
      prompt: "What state do I need to be in today?",
    },
  ],
};

export const EVENING_FIELDS: Record<RitualVariant, RitualField[]> = {
  operational: [
    ...SCORE_FIELDS,
    {
      key: "mip_score_1",
      kind: "categorical",
      prompt: "Score on MIP #1",
      options: MIP_SCORE_OPTIONS,
    },
    {
      key: "mip_score_2",
      kind: "categorical",
      prompt: "Score on MIP #2",
      options: MIP_SCORE_OPTIONS,
    },
    {
      key: "mip_score_3",
      kind: "categorical",
      prompt: "Score on MIP #3",
      options: MIP_SCORE_OPTIONS,
    },
    { key: "anything_else", kind: "text", prompt: "Anything else?" },
  ],
  state: [
    ...SCORE_FIELDS,
    {
      key: "state_slip",
      kind: "text",
      prompt: "Where did your state slip? What pulled you out?",
    },
    { key: "anything_else", kind: "text", prompt: "Anything else?" },
  ],
  inquiry: [
    ...SCORE_FIELDS,
    {
      key: "stressful_thought_today",
      kind: "text",
      prompt:
        "What stressful thought arose today that you haven't questioned?",
    },
    { key: "anything_else", kind: "text", prompt: "Anything else?" },
  ],
  mixed: [
    ...SCORE_FIELDS,
    {
      key: "stressful_thought",
      kind: "text",
      prompt: "Any stressful thought today?",
    },
    {
      key: "state_shift",
      kind: "text",
      prompt: "Did your state shift?",
    },
    { key: "anything_else", kind: "text", prompt: "Anything else?" },
  ],
};

export function fieldsFor(
  variant: RitualVariant,
  type: RitualType,
): RitualField[] {
  return type === "morning_ritual"
    ? MORNING_FIELDS[variant]
    : EVENING_FIELDS[variant];
}

// Tier-aware payload composition. Per Tab 2 19:10 UTC lock + 20:05 UTC patch:
//   tier 1: structured + text both NULL (just a session-occurred stamp)
//   tier 2: structured only (chartable data), text NULL
//   tier 3: structured + text
//   tier 4: same writes as tier 3 (correlation engine reads, doesn't write)
//
// The locked shape is NOT a mechanical "dump fields by kind" — it's
// purposeful. Specifically:
//   - Operational morning numeric_data: { mip_energies: ['red','yellow','green'] }
//     (single array, not three keys)
//   - State morning numeric_data: { gratitude_count: N }
//     (derived count, NOT the text)
//   - Inquiry morning numeric_data: { thought_present: bool }
//     (derived boolean from text presence)
//   - Mixed morning numeric_data: { mip_count_filled: N }
//     (derived count from MIP text presence)
//   - Operational evening numeric_data also has { mip_scores: [...] } array
//   - All evenings: { energy, focus, mood } 1-10 scores directly
//
// Why derived/array shape: the v1 correlation engine queries shapes like
// `numeric_data->>'mip_count_filled' as filled`. If we stored mip_1, mip_2,
// mip_3 as separate keys, the engine would have to know each variant's
// field set. The locked shape gives it ONE chartable signal per variant.
//
// Pre-patch (Commit B initial): mechanical kind-based dump. Caught by
// Tab 2 in browser-verification pre-flight: mixed-morning tier-2 came back
// with both columns null because mixed has no NumberField/CategoricalField.
// This patch restores the locked shape across all 8 variants + adds the
// inverse decode for prefill.

export type ComposedPayload = {
  numeric_data: Record<string, unknown> | null;
  text_data: Record<string, unknown> | null;
};

type RawValue = string | number | undefined;

function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function nonEmpty(strs: (string | undefined)[]): string[] {
  return strs.filter(
    (s): s is string => typeof s === "string" && s.trim().length > 0,
  );
}

function composeNumericMorning(
  variant: RitualVariant,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  if (variant === "operational") {
    // Filter to non-empty energies (preserves null slots if some unfilled
    // would distort the array; the v0 user fills all 3 or none).
    const energies = nonEmpty([
      strOrUndef(raw.mip_energy_1),
      strOrUndef(raw.mip_energy_2),
      strOrUndef(raw.mip_energy_3),
    ]);
    return energies.length > 0 ? { mip_energies: energies } : {};
  }
  if (variant === "state") {
    const gratitudeCount = nonEmpty([
      strOrUndef(raw.gratitude_1),
      strOrUndef(raw.gratitude_2),
      strOrUndef(raw.gratitude_3),
    ]).length;
    return gratitudeCount > 0 ? { gratitude_count: gratitudeCount } : {};
  }
  if (variant === "inquiry") {
    const thought = strOrUndef(raw.thought);
    return {
      thought_present: !!(thought && thought.trim().length > 0),
    };
  }
  // mixed
  const mipCountFilled = nonEmpty([
    strOrUndef(raw.mip_1),
    strOrUndef(raw.mip_2),
    strOrUndef(raw.mip_3),
  ]).length;
  return mipCountFilled > 0 ? { mip_count_filled: mipCountFilled } : {};
}

function composeNumericEvening(
  variant: RitualVariant,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const e = numOrUndef(raw.energy);
  const f = numOrUndef(raw.focus);
  const m = numOrUndef(raw.mood);
  if (e !== undefined) out.energy = e;
  if (f !== undefined) out.focus = f;
  if (m !== undefined) out.mood = m;
  if (variant === "operational") {
    const scores = nonEmpty([
      strOrUndef(raw.mip_score_1),
      strOrUndef(raw.mip_score_2),
      strOrUndef(raw.mip_score_3),
    ]);
    if (scores.length > 0) out.mip_scores = scores;
  }
  return out;
}

function composeTextMorning(
  variant: RitualVariant,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (variant === "operational") {
    const mips = nonEmpty([
      strOrUndef(raw.mip_1),
      strOrUndef(raw.mip_2),
      strOrUndef(raw.mip_3),
    ]);
    if (mips.length > 0) out.mips = mips;
    const intention = strOrUndef(raw.intention);
    if (intention) out.intention = intention;
    return out;
  }
  if (variant === "state") {
    const gratitudes = nonEmpty([
      strOrUndef(raw.gratitude_1),
      strOrUndef(raw.gratitude_2),
      strOrUndef(raw.gratitude_3),
    ]);
    if (gratitudes.length > 0) out.gratitudes = gratitudes;
    for (const k of ["priming_answer", "focus", "meaning"] as const) {
      const v = strOrUndef(raw[k]);
      if (v) out[k] = v;
    }
    return out;
  }
  if (variant === "inquiry") {
    for (const k of ["thought", "q1", "q2", "q3", "q4", "turnaround"] as const) {
      const v = strOrUndef(raw[k]);
      if (v) out[k] = v;
    }
    return out;
  }
  // mixed
  const mips = nonEmpty([
    strOrUndef(raw.mip_1),
    strOrUndef(raw.mip_2),
    strOrUndef(raw.mip_3),
  ]);
  if (mips.length > 0) out.mips = mips;
  const priming = strOrUndef(raw.priming_answer);
  if (priming) out.priming_answer = priming;
  return out;
}

function composeTextEvening(
  variant: RitualVariant,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (variant === "operational") {
    const anyElse = strOrUndef(raw.anything_else);
    if (anyElse) out.anything_else = anyElse;
    return out;
  }
  if (variant === "state") {
    for (const k of ["state_slip", "anything_else"] as const) {
      const v = strOrUndef(raw[k]);
      if (v) out[k] = v;
    }
    return out;
  }
  if (variant === "inquiry") {
    for (const k of ["stressful_thought_today", "anything_else"] as const) {
      const v = strOrUndef(raw[k]);
      if (v) out[k] = v;
    }
    return out;
  }
  // mixed
  for (const k of ["stressful_thought", "state_shift", "anything_else"] as const) {
    const v = strOrUndef(raw[k]);
    if (v) out[k] = v;
  }
  return out;
}

export function composePayload(
  tier: StorageTier,
  variant: RitualVariant,
  type: RitualType,
  raw: Record<string, unknown>,
): ComposedPayload {
  if (tier === 1) {
    return { numeric_data: null, text_data: null };
  }

  const numeric =
    type === "morning_ritual"
      ? composeNumericMorning(variant, raw)
      : composeNumericEvening(variant, raw);

  const text =
    tier >= 3
      ? type === "morning_ritual"
        ? composeTextMorning(variant, raw)
        : composeTextEvening(variant, raw)
      : null;

  return {
    numeric_data: Object.keys(numeric).length > 0 ? numeric : null,
    text_data: text && Object.keys(text).length > 0 ? text : null,
  };
}

// Inverse of composePayload — takes the stored locked shape and produces a
// flat key/value map keyed by form field names (mip_energy_1/2/3, gratitude_1
// /2/3, etc.). Used by /daily for prefill: server stores `mip_energies:
// [...]`, form expects individual keys, decode bridges the two.
//
// If we ever rename a locked-shape key in numeric_data or text_data, the
// matching unpacking line here changes too. Keep them in lockstep.
export function decomposeFromStorage(
  numericData: Record<string, unknown> | null,
  textData: Record<string, unknown> | null,
): Record<string, RawValue> {
  const n = numericData ?? {};
  const t = textData ?? {};
  const out: Record<string, RawValue> = {};

  // Arrays from numeric_data → individual indexed keys.
  if (Array.isArray(n.mip_energies)) {
    n.mip_energies.forEach((v, i) => {
      if (typeof v === "string") out[`mip_energy_${i + 1}`] = v;
    });
  }
  if (Array.isArray(n.mip_scores)) {
    n.mip_scores.forEach((v, i) => {
      if (typeof v === "string") out[`mip_score_${i + 1}`] = v;
    });
  }

  // Scalar numeric scores (evening) pass through directly.
  for (const k of ["energy", "focus", "mood"]) {
    if (typeof n[k] === "number") out[k] = n[k] as number;
  }

  // Derived signals (gratitude_count / thought_present / mip_count_filled)
  // are NOT decoded into form fields — they're write-only chartables.

  // Arrays from text_data → individual indexed keys.
  if (Array.isArray(t.mips)) {
    t.mips.forEach((v, i) => {
      if (typeof v === "string") out[`mip_${i + 1}`] = v;
    });
  }
  if (Array.isArray(t.gratitudes)) {
    t.gratitudes.forEach((v, i) => {
      if (typeof v === "string") out[`gratitude_${i + 1}`] = v;
    });
  }

  // Scalar text fields pass through (intention, priming_answer, focus,
  // meaning, thought, q1-q4, turnaround, state_slip, stressful_thought*,
  // state_shift, anything_else).
  for (const k of [
    "intention",
    "priming_answer",
    "focus",
    "meaning",
    "thought",
    "q1",
    "q2",
    "q3",
    "q4",
    "turnaround",
    "state_slip",
    "stressful_thought_today",
    "stressful_thought",
    "state_shift",
    "anything_else",
  ]) {
    if (typeof t[k] === "string") out[k] = t[k] as string;
  }

  return out;
}

// Server-side validation. Refuses any field that doesn't match its declared
// kind. Empty / missing fields are OK — a ritual entry can be partial.

export type ValidationResult =
  | { ok: true; raw: Record<string, unknown> }
  | { ok: false; error: string };

export function validateRaw(
  variant: RitualVariant,
  type: RitualType,
  input: unknown,
): ValidationResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "body_not_object" };
  }
  const body = input as { raw?: unknown };
  if (!body.raw || typeof body.raw !== "object") {
    return { ok: false, error: "raw_not_object" };
  }
  const raw = body.raw as Record<string, unknown>;

  const fields = fieldsFor(variant, type);
  const cleaned: Record<string, unknown> = {};

  for (const field of fields) {
    const value = raw[field.key];
    if (value === undefined || value === null || value === "") continue;

    if (field.kind === "text") {
      if (typeof value !== "string") {
        return { ok: false, error: `field_${field.key}_not_string` };
      }
      cleaned[field.key] = value.slice(0, 2000); // cap per field
    } else if (field.kind === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, error: `field_${field.key}_not_number` };
      }
      if (value < field.min || value > field.max) {
        return { ok: false, error: `field_${field.key}_out_of_range` };
      }
      cleaned[field.key] = value;
    } else {
      // categorical
      if (typeof value !== "string" || !field.options.includes(value)) {
        return { ok: false, error: `field_${field.key}_invalid_option` };
      }
      cleaned[field.key] = value;
    }
  }

  return { ok: true, raw: cleaned };
}
