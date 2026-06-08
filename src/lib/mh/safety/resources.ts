// Regional crisis resources surfaced inside the safety escalation script.
// Per Tab 2 01:05 UTC spec advance: region detected from Clerk timezone in
// regionDetect.ts, defaulting to IN when unclear.
//
// Numbers verified against MH_UI_SPEC.md L307-311 + the chatPrompt.ts inline
// minimal version. If any number changes (e.g. India's iCall moves) update
// here AND the legacy inline reference in chatPrompt.ts will be removed when
// Commit F replaces it.

export type Region = "IN" | "US" | "UK" | "EU" | "OTHER";

export type RegionalResources = {
  region: Region;
  resources: Array<{ name: string; contact: string }>;
};

const RESOURCES_BY_REGION: Record<Region, RegionalResources> = {
  IN: {
    region: "IN",
    resources: [
      { name: "iCall", contact: "9152987821 (Mon-Sat 8am-10pm)" },
      { name: "Vandrevala Foundation", contact: "1860-2662-345 (24/7)" },
    ],
  },
  US: {
    region: "US",
    resources: [{ name: "988 Suicide & Crisis Lifeline", contact: "988" }],
  },
  UK: {
    region: "UK",
    resources: [{ name: "Samaritans", contact: "116 123" }],
  },
  EU: {
    region: "EU",
    resources: [
      {
        name: "International Association for Suicide Prevention",
        contact: "https://www.iasp.info/resources/Crisis_Centres",
      },
    ],
  },
  OTHER: {
    region: "OTHER",
    resources: [
      {
        name: "International Association for Suicide Prevention",
        contact: "https://www.iasp.info/resources/Crisis_Centres",
      },
    ],
  },
};

export function resourcesFor(region: Region): RegionalResources {
  return RESOURCES_BY_REGION[region] ?? RESOURCES_BY_REGION.IN;
}

// Renders the escalation script body using region-appropriate resources.
// Used by both the chat route (when safety screen triggers pre-LLM) and the
// LLM system prompt (which is told to output this verbatim).
export function escalationScript(region: Region): string {
  const r = resourcesFor(region);
  const lines = r.resources.map((res) => `- ${res.name}: ${res.contact}`);
  return [
    "This is bigger than what I'm built for. Please reach out to a professional right now:",
    "",
    ...lines,
    "",
    "I'll be here when you're ready.",
  ].join("\n");
}
