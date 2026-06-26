// Morning audio briefing script generation (Commit 19a).
//
// Gemini per the same pattern as signal.ts + digest.ts. NOT Anthropic
// (no SDK installed). Target output: 600-900 character script that reads
// aloud in ~4-5 minutes at a calm pace via Google TTS WaveNet voice.

import { generateText } from "ai";
import { getGeminiModel, LLM_MAX_RETRIES } from "./gemini";

export type BriefingSource = {
  firstName: string;
  urgentEmails: Array<{ subject: string; from_address: string }>;
  decisionsAwaitingPostmortem: Array<{ title: string }>;
  calendarToday: Array<{ title: string; start_at: string; prep_priority: string | null }>;
  slackUnreadCount: number;
  cadenceColdContacts: Array<{ display_name: string }>;
  todaysSignal: string | null;
};

const SYSTEM_PROMPT = `You write a 4-5 minute morning audio briefing for a busy founder. Conversational, warm, second person ("you", "your"). Lowercase prose. Read aloud — so no headings, no bullets, no markdown. Each sentence should sound natural spoken.

Structure (roughly):
1. Open with a one-line "good morning {name}" and the single most important thing today.
2. Walk through urgent emails by name (sender + 5-word context).
3. Mention any decisions awaiting postmortem.
4. Cover today's calendar — names + times.
5. Note cadence-cold contacts as gentle "you might reach out to X" mentions.
6. End with one forward-looking line ("set you up for a quiet morning" / "today's the day to tackle X" / etc.)

Total length: 600-900 characters. The reader is groggy at 6am — short clear sentences, no jargon.`;

export async function generateBriefingScript(
  source: BriefingSource,
): Promise<{ script: string }> {
  const userPrompt = `Good morning context for ${source.firstName}:

Today's signal (if any): ${source.todaysSignal ?? "none yet"}

Urgent emails:
${source.urgentEmails.slice(0, 5).map((e) => `- "${e.subject}" from ${e.from_address}`).join("\n") || "none"}

Decisions awaiting postmortem:
${source.decisionsAwaitingPostmortem.slice(0, 3).map((d) => `- ${d.title}`).join("\n") || "none"}

Today's calendar:
${source.calendarToday.slice(0, 5).map((c) => `- ${c.title} @ ${new Date(c.start_at).toISOString().slice(11, 16)}${c.prep_priority === "high" ? " (high prep)" : ""}`).join("\n") || "no meetings"}

Slack unread (urgent): ${source.slackUnreadCount}

Cadence-cold contacts (28+ days):
${source.cadenceColdContacts.slice(0, 3).map((c) => `- ${c.display_name}`).join("\n") || "none"}

Write the briefing script now (600-900 chars, lowercase prose, no headings).`;

  const { text } = await generateText({
    model: getGeminiModel(),
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
    maxRetries: LLM_MAX_RETRIES,
  });

  return { script: text.trim() };
}
