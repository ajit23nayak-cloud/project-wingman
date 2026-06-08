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

// Tier-aware payload composition. Per Tab 2 19:10 UTC lock:
//   tier 1: structured + text both NULL (just a session-occurred stamp)
//   tier 2: structured only (chartable data), text NULL
//   tier 3: structured + text
//   tier 4: same writes as tier 3 (correlation engine reads, doesn't write)
//
// "Structured" fields = NumberField + CategoricalField. They go into
// numeric_data jsonb. "Text" fields = TextField. They go into text_data
// jsonb. The split is mechanical: kind of field → which column.

export type ComposedPayload = {
  numeric_data: Record<string, unknown> | null;
  text_data: Record<string, unknown> | null;
};

export function composePayload(
  tier: StorageTier,
  variant: RitualVariant,
  type: RitualType,
  raw: Record<string, unknown>,
): ComposedPayload {
  if (tier === 1) {
    return { numeric_data: null, text_data: null };
  }

  const fields = fieldsFor(variant, type);
  const numericData: Record<string, unknown> = {};
  const textData: Record<string, unknown> = {};

  for (const field of fields) {
    const value = raw[field.key];
    if (value === undefined || value === null || value === "") continue;

    if (field.kind === "text") {
      if (tier >= 3) textData[field.key] = value;
    } else {
      numericData[field.key] = value;
    }
  }

  return {
    numeric_data: Object.keys(numericData).length > 0 ? numericData : null,
    text_data: Object.keys(textData).length > 0 ? textData : null,
  };
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
