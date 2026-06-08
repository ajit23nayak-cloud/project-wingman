// Region detection from Clerk session timezone. Default IN per Tab 2 01:05
// UTC lock — India-first cohort, fall back to IN resources for any unknown
// timezone rather than the generic IASP link.

import type { Region } from "./resources";

// Coarse buckets of IANA timezones → Region. Not exhaustive; intentional —
// we only need enough resolution to pick the right resource bucket.
//
// "America/*" → US
// "Europe/London", "Europe/Belfast" → UK
// "Europe/*" (other) → EU
// "Asia/Kolkata", "Asia/Calcutta" → IN
// Everything else → OTHER (renders IASP global link)

export function regionFromTimezone(timezone: string | null | undefined): Region {
  if (!timezone || typeof timezone !== "string") return "IN";
  const tz = timezone.toLowerCase();

  if (tz === "asia/kolkata" || tz === "asia/calcutta") return "IN";

  if (tz === "europe/london" || tz === "europe/belfast") return "UK";

  if (tz.startsWith("america/")) {
    // US states + Canada both fit here for v0; Canadian crisis resources
    // are a v1 detail. US 988 line works across NANP for now.
    return "US";
  }

  if (tz.startsWith("europe/")) return "EU";

  return "OTHER";
}

// Convenience helper to extract timezone from Clerk session claims and route
// to region in one call. sessionClaims['timezone'] isn't a standard Clerk
// claim; clients can add it via session token templates. If absent, falls
// back to IN.
export function regionFromClaims(
  sessionClaims: Record<string, unknown> | undefined | null,
): Region {
  if (!sessionClaims) return "IN";
  const tz = sessionClaims["timezone"];
  if (typeof tz !== "string") return "IN";
  return regionFromTimezone(tz);
}
