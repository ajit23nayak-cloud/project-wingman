// Safety escalation logger. Writes to two places per Tab 2 01:05 UTC lock:
//   1. public.mh_escalations row (server-side, via service_role) — drives
//      the proactive dashboard nudge at >=3 escalations in 7 days.
//   2. PostHog event `mh_safety_escalation_triggered` — observability for
//      admin (no admin route in v0; PostHog is the dashboard).
//
// Never logs the user's message content. Only metadata: region, source
// route, detection layer. The user's text is the most sensitive thing
// possible — keep it out of the log forever.

import { PostHog } from "posthog-node";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Region } from "./resources";
import type { SafetyDetectionLayer } from "./screen";

let _posthog: PostHog | null = null;
function posthog(): PostHog | null {
  // PostHog is optional — if the key isn't set (e.g. local dev without
  // observability), skip the event silently. Database log still happens.
  if (_posthog) return _posthog;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? process.env.POSTHOG_KEY;
  if (!key) return null;
  _posthog = new PostHog(key, {
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://app.posthog.com",
    flushAt: 1, // fire-and-forget per event
    flushInterval: 0,
  });
  return _posthog;
}

export type LogEscalationInput = {
  supabaseUserId: string;
  region: Region;
  sourceRoute: string;
  detectionLayer: SafetyDetectionLayer;
};

export async function logEscalation(
  supabase: SupabaseClient,
  input: LogEscalationInput,
): Promise<void> {
  // DB write — primary record. If this fails, log loudly but don't throw;
  // the safety escalation script must still reach the user even if logging
  // breaks. Same reasoning as Commit B's "Gmail succeeded but post-send
  // update failed — message is delivered, log lag is acceptable."
  try {
    const { error } = await supabase.from("mh_escalations").insert({
      user_id: input.supabaseUserId,
      region: input.region,
      source_route: input.sourceRoute,
      detection_layer: input.detectionLayer,
    });
    if (error) {
      console.error("[safety/log] mh_escalations insert failed", {
        supabaseUserId: input.supabaseUserId,
        message: error.message,
      });
    }
  } catch (err) {
    console.error("[safety/log] mh_escalations insert threw", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // PostHog event — observability layer. Same fail-soft pattern.
  const ph = posthog();
  if (ph) {
    try {
      ph.capture({
        distinctId: input.supabaseUserId,
        event: "mh_safety_escalation_triggered",
        properties: {
          region: input.region,
          source_route: input.sourceRoute,
          detection_layer: input.detectionLayer,
        },
      });
      await ph.flush();
    } catch (err) {
      console.error("[safety/log] PostHog capture threw", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
