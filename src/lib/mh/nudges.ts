// Contextual nudges — single source of truth for triggers, style routing,
// and copy templates per (trigger, pattern, style). Pure functions; no SWR,
// no DB. Consumers (useNudges in hooks.ts) feed in the already-loaded data.
//
// v0 scope per Tab 2 22:50 UTC lock:
//   - 2 triggers (urgent-overflow, missed-ritual). 8 other spec triggers
//     ride with their dependency features in v1.
//   - 2 patterns (widget, observation). Modal deferred to v1 alongside
//     decision log + angry-tone classifier that justify it.
//   - Style routing: operational + mixed → widget only.
//     state + inquiry → widget + observation.
//
// v1 inflection points (when we'd re-architect):
//   - Trigger count > 5: migrate trigger detection from dashboard-mount
//     compute to a cron-driven mh_triggers queue table. Current cost is
//     2 extra reads on dashboard mount — fine for v0, will get slow when
//     calendar/decision/activity triggers join.
//   - Multi-user trial: server-side frequency cap state via mh_nudges
//     table. v0 uses localStorage (clearable → bypassable, but acceptable
//     for single-user trial).
//   - Modal needs landing: ships alongside Commit-D angry-tone classifier
//     OR Commit-35/36 decision log entries (whichever interrupts an action
//     worth interrupting).

import type { MhStyle } from "@/lib/supabase/hooks";

// Thresholds isolated as named constants so v1 tuning is a one-line change.
// Don't inline magic numbers into trigger logic.
export const URGENT_OVERFLOW_THRESHOLD = 10;
export const MISSED_RITUAL_DAYS = 3;
export const MAX_OBSERVATIONS_PER_LOAD = 3;

export type TriggerId = "urgent_overflow" | "missed_ritual";
export type Pattern = "widget" | "observation";

export type ActiveTrigger = {
  id: TriggerId;
  // Trigger-specific facts the copy templates interpolate (counts, days).
  data: Record<string, unknown>;
};

export type ComputeInput = {
  urgentCount: number;
  // null = no ritual entry has ever existed for this user.
  daysSinceLastRitual: number | null;
};

export function computeTriggers(input: ComputeInput): ActiveTrigger[] {
  const out: ActiveTrigger[] = [];

  if (input.urgentCount > URGENT_OVERFLOW_THRESHOLD) {
    out.push({
      id: "urgent_overflow",
      data: { urgentCount: input.urgentCount },
    });
  }

  // Trigger when: no ritual ever, OR last ritual >= MISSED_RITUAL_DAYS ago.
  // A user with daysSinceLastRitual = 0 (did one today) doesn't trigger;
  // daysSinceLastRitual = 1 (did one yesterday) doesn't trigger; 3+ does.
  if (
    input.daysSinceLastRitual === null ||
    input.daysSinceLastRitual >= MISSED_RITUAL_DAYS
  ) {
    out.push({
      id: "missed_ritual",
      data: {
        daysSinceLastRitual: input.daysSinceLastRitual,
        neverDone: input.daysSinceLastRitual === null,
      },
    });
  }

  return out;
}

// Style routing per spec L122-125 + Tab 2 22:50 UTC simplification (modal
// dropped):
//   operational → widget only
//   state       → widget + observation
//   inquiry     → widget + observation
//   mixed       → widget only
//   state-B (mh_style null + never skipped) → no nudges (banner-nudged
//   to assessment first; don't compete for attention)
export function patternsFor(
  _triggerId: TriggerId,
  mhStyle: MhStyle | null,
  assessmentSkipped: boolean,
): Pattern[] {
  // State B: assessment not yet engaged. Hide nudges so the assessment
  // banner is the only call to action.
  if (mhStyle === null && !assessmentSkipped) {
    return [];
  }
  // Mixed mode (skipped users) and Operational both get widget only.
  if (mhStyle === null || mhStyle === "operational") {
    return ["widget"];
  }
  // State + Inquiry get both.
  return ["widget", "observation"];
}

export type WidgetContent = {
  title: string;
  body: string;
};

export type ObservationContent = {
  // Italic text. Click-through navigates to href.
  text: string;
  href: string;
};

export type NudgeContent = {
  widget?: WidgetContent;
  observation?: ObservationContent;
};

// Per-(trigger, style) copy. Per Tab 2 22:50 UTC consistency check: same
// data, different framing per style. Operational gets the action-oriented
// frame; inquiry gets the question-oriented frame; state gets the energy/
// embodiment frame. Mixed reuses the operational frame (safe + neutral).
export function copyFor(
  trigger: ActiveTrigger,
  mhStyle: MhStyle | null,
): NudgeContent {
  const style: MhStyle | "mixed" = mhStyle ?? "mixed";

  if (trigger.id === "urgent_overflow") {
    const n = Number(trigger.data.urgentCount ?? 0);
    if (style === "operational" || style === "mixed") {
      return {
        widget: {
          title: "Urgent bucket is full",
          body: `${n} emails are tagged Urgent. Five minutes of triage now saves an hour tomorrow.`,
        },
        observation: {
          text: `${n} Urgents on the board. Worth a pass?`,
          href: "/dashboard",
        },
      };
    }
    if (style === "state") {
      return {
        widget: {
          title: "Heavy week shaping up",
          body: `${n} emails marked Urgent. Notice what that's doing to your state — and decide before reacting.`,
        },
        observation: {
          text: `${n} Urgents. Take a breath before the next reply?`,
          href: "/daily",
        },
      };
    }
    // inquiry
    return {
      widget: {
        title: "Urgent count is climbing",
        body: `${n} emails labeled Urgent. Worth asking: is this the actual urgency, or how it feels right now?`,
      },
      observation: {
        text: `${n} Urgents. Is each one as urgent as it looks?`,
        href: "/daily",
      },
    };
  }

  // missed_ritual
  const days = trigger.data.daysSinceLastRitual as number | null;
  const neverDone = !!trigger.data.neverDone;
  const dayLabel = neverDone
    ? "yet"
    : days === null
      ? "yet"
      : `${days} days`;

  if (style === "operational" || style === "mixed") {
    return {
      widget: {
        title: "Your morning ritual is waiting",
        body: neverDone
          ? "Three minutes to set today's MIPs. The cadence compounds."
          : `${dayLabel} since your last ritual. Three minutes to reset.`,
      },
      observation: {
        text: neverDone
          ? "First ritual: 3 min."
          : `Off the practice ${dayLabel}. Open it?`,
        href: "/daily",
      },
    };
  }
  if (style === "state") {
    return {
      widget: {
        title: "Time to recalibrate",
        body: neverDone
          ? "Three minutes to check in on your state. Where are you starting from?"
          : `${dayLabel} off the practice. Where's your energy at right now?`,
      },
      observation: {
        text: neverDone
          ? "First check-in: how's your energy?"
          : `${dayLabel} off. How's your state?`,
        href: "/daily",
      },
    };
  }
  // inquiry
  return {
    widget: {
      title: "Worth checking in",
      body: neverDone
        ? "What thought is sitting heaviest right now? Three minutes with it."
        : `${dayLabel} off the practice. What's in the way?`,
    },
    observation: {
      text: neverDone
        ? "First sit: what's loudest right now?"
        : `${dayLabel} off. What's in the way?`,
      href: "/daily",
    },
  };
}
