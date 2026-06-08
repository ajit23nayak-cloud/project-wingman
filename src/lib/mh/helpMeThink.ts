// On-demand "Help me think" — 4 route definitions, validation, tier-aware
// compose. Mirrors the ritual.ts pattern: single source of truth for both
// the modal UI and the API handler.
//
// Locked per Tab 2 23:35 UTC spec advance + Ajit's "all 8 per Tab 2 rec"
// confirmation:
//   - 4 routes: decision (OPA) / inquiry (Katie 4Qs) / drained (energy
//     audit, user types tasks inline) / other (chat fallback).
//   - framework_used per route is FIXED for the 3 deterministic routes;
//     chat uses the user's mh_style ?? 'mixed'.
//   - Per-tier persistence shape locked at Flag A.
//   - Chat transcript at tier 3+ stores BOTH user + assistant turns (Tab 1
//     small Q confirmed by "all 8 per Tab 2 rec").

import type { MhStyle } from "@/lib/supabase/hooks";
import type { StorageTier, RitualVariant } from "@/lib/mh/ritual";

export type HelpRoute = "decision" | "inquiry" | "drained" | "other";

// Route → framework_used mapping. Fixed for 3 deterministic routes (per spec
// L151-154); chat takes the user's style or 'mixed' for skip users.
export function frameworkUsedFor(
  route: HelpRoute,
  mhStyle: MhStyle | null,
): RitualVariant {
  switch (route) {
    case "decision":
      return "state"; // OPA is Robbins-derived
    case "inquiry":
      return "inquiry"; // Katie's 4 questions
    case "drained":
      return "operational"; // Mochary energy audit
    case "other":
      return mhStyle ?? "mixed"; // chat takes user's style
  }
}

// --- Per-route validation ---------------------------------------------------

export type ValidationResult =
  | { ok: true; cleaned: Record<string, unknown> }
  | { ok: false; error: string };

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNonEmptyString(v: unknown, max = 2000): string | undefined {
  const s = asString(v);
  if (!s) return undefined;
  const trimmed = s.trim();
  if (trimmed.length === 0) return undefined;
  return s.slice(0, max);
}

const CHAT_TRANSCRIPT_MAX_TURNS = 8;
const ENERGY_COLORS = ["red", "yellow", "green"] as const;
type EnergyColor = (typeof ENERGY_COLORS)[number];

function asColor(v: unknown): EnergyColor | undefined {
  if (typeof v !== "string") return undefined;
  if ((ENERGY_COLORS as readonly string[]).includes(v)) {
    return v as EnergyColor;
  }
  return undefined;
}

export function validateOnDemand(
  route: HelpRoute,
  rawInput: unknown,
): ValidationResult {
  if (!rawInput || typeof rawInput !== "object") {
    return { ok: false, error: "raw_not_object" };
  }
  const raw = rawInput as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};

  if (route === "decision") {
    for (const k of ["outcome", "purpose", "action"]) {
      const v = asNonEmptyString(raw[k]);
      if (v) cleaned[k] = v;
    }
    return { ok: true, cleaned };
  }

  if (route === "inquiry") {
    for (const k of ["thought", "q1", "q2", "q3", "q4", "turnaround"]) {
      const v = asNonEmptyString(raw[k]);
      if (v) cleaned[k] = v;
    }
    return { ok: true, cleaned };
  }

  if (route === "drained") {
    // Tasks + colors arrays, max 7 per spec recommendation (energy audit
    // works best for 3-7 items; cap at 7).
    const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
    const colors = Array.isArray(raw.colors) ? raw.colors : [];
    if (tasks.length !== colors.length) {
      return { ok: false, error: "tasks_colors_length_mismatch" };
    }
    if (tasks.length > 7) {
      return { ok: false, error: "too_many_tasks" };
    }
    const cleanedTasks: string[] = [];
    const cleanedColors: EnergyColor[] = [];
    for (let i = 0; i < tasks.length; i++) {
      const t = asNonEmptyString(tasks[i], 300);
      const c = asColor(colors[i]);
      if (!t || !c) continue; // skip empty pairs silently
      cleanedTasks.push(t);
      cleanedColors.push(c);
    }
    if (cleanedTasks.length > 0) {
      cleaned.tasks = cleanedTasks;
      cleaned.colors = cleanedColors;
    }
    return { ok: true, cleaned };
  }

  // route === "other" (chat)
  const transcript = Array.isArray(raw.transcript) ? raw.transcript : [];
  if (transcript.length === 0) {
    return { ok: false, error: "empty_transcript" };
  }
  if (transcript.length > CHAT_TRANSCRIPT_MAX_TURNS) {
    return { ok: false, error: "transcript_too_long" };
  }
  const cleanedTranscript: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const entry of transcript) {
    if (!entry || typeof entry !== "object") {
      return { ok: false, error: "transcript_entry_not_object" };
    }
    const e = entry as { role?: unknown; content?: unknown };
    if (e.role !== "user" && e.role !== "assistant") {
      return { ok: false, error: "transcript_entry_invalid_role" };
    }
    const content = asNonEmptyString(e.content, 4000);
    if (!content) {
      return { ok: false, error: "transcript_entry_empty_content" };
    }
    cleanedTranscript.push({ role: e.role, content });
  }
  cleaned.transcript = cleanedTranscript;
  return { ok: true, cleaned };
}

// --- Tier-aware compose -----------------------------------------------------
// Shapes locked per Tab 2 23:35 UTC Flag A:
//   decision  tier 2: numeric_data = { route:'decision' }
//             tier 3+: text_data    = { outcome, purpose, action }
//   inquiry   tier 2: numeric_data = { route:'inquiry', thought_present:bool }
//             tier 3+: text_data    = { thought, q1, q2, q3, q4, turnaround }
//   drained   tier 2: numeric_data = { route:'drained', task_count, red_count,
//                                      yellow_count, green_count }
//             tier 3+: text_data    = { tasks, colors }
//   other     tier 2: numeric_data = { route:'other', turns }
//             tier 3+: text_data    = { transcript: [{role, content}] }
//
// The `route` tag in numeric_data is the tier-2 way to distinguish session
// types (since type='on_demand' at the row level doesn't tell us which of
// the 4 routes was used). Tier 1 loses this distinction entirely.

export type ComposedOnDemand = {
  numeric_data: Record<string, unknown> | null;
  text_data: Record<string, unknown> | null;
};

export function composeOnDemand(
  tier: StorageTier,
  route: HelpRoute,
  cleaned: Record<string, unknown>,
): ComposedOnDemand {
  if (tier === 1) {
    return { numeric_data: null, text_data: null };
  }

  const numeric: Record<string, unknown> = { route };
  const text: Record<string, unknown> = {};

  if (route === "decision") {
    if (tier >= 3) {
      for (const k of ["outcome", "purpose", "action"]) {
        const v = cleaned[k];
        if (typeof v === "string") text[k] = v;
      }
    }
  } else if (route === "inquiry") {
    const thought = cleaned.thought;
    numeric.thought_present = typeof thought === "string" && thought.length > 0;
    if (tier >= 3) {
      for (const k of ["thought", "q1", "q2", "q3", "q4", "turnaround"]) {
        const v = cleaned[k];
        if (typeof v === "string") text[k] = v;
      }
    }
  } else if (route === "drained") {
    const tasks = (cleaned.tasks as string[] | undefined) ?? [];
    const colors = (cleaned.colors as EnergyColor[] | undefined) ?? [];
    numeric.task_count = tasks.length;
    numeric.red_count = colors.filter((c) => c === "red").length;
    numeric.yellow_count = colors.filter((c) => c === "yellow").length;
    numeric.green_count = colors.filter((c) => c === "green").length;
    if (tier >= 3 && tasks.length > 0) {
      text.tasks = tasks;
      text.colors = colors;
    }
  } else {
    // other (chat)
    const transcript =
      (cleaned.transcript as Array<{ role: string; content: string }> | undefined) ?? [];
    numeric.turns = transcript.length;
    if (tier >= 3 && transcript.length > 0) {
      text.transcript = transcript;
    }
  }

  return {
    numeric_data: Object.keys(numeric).length > 0 ? numeric : null,
    text_data:
      tier >= 3 && Object.keys(text).length > 0 ? text : null,
  };
}

export { CHAT_TRANSCRIPT_MAX_TURNS };
