// Today's Signal generation prompt. Reads recent dashboard sources for one
// user, asks Gemini for ONE short sentence summarizing what matters most
// today. Output stored in dashboard_signals.summary_text (NOT NULL per
// migration 0025).
//
// Gemini default per src/lib/llm/gemini.ts. NOT Anthropic (Tab 2 spec
// mistakenly named Claude Sonnet 4.6 but no Anthropic SDK is installed
// and Gemini is the existing classifier provider — consistency + cost).

import { generateText } from "ai";
import { getGeminiModel, LLM_MAX_RETRIES } from "./gemini";

export type SignalSource = {
  emails: Array<{ subject: string; classification: string | null; received_at: number }>;
  decisions: Array<{ title: string; postmortem_due_at: string | null }>;
  calendar: Array<{ title: string; prep_priority: string | null; start_at: string }>;
  slackUnreadCount: number;
  cadenceColdCount: number;
};

const SYSTEM_PROMPT = `You read a founder's dashboard data and write ONE sentence (<= 18 words) summarizing what matters most TODAY. Lowercase. No greeting, no preamble. Lead with the highest-urgency item by name.

Examples:
- "sequoia term sheet redline still overdue + customer call with acme at 16:30."
- "all caught up — 0 urgent, calendar light, take the breather."
- "3 decisions need postmortems this week and pat hasn't heard from you in 21 days."`;

export async function generateTodaysSignal(
  source: SignalSource,
): Promise<{ summary: string }> {
  const userPrompt = `Today's data:
- Urgent emails (last 24h): ${source.emails.filter((e) => e.classification === "urgent").map((e) => e.subject).slice(0, 5).join(" | ") || "none"}
- Decisions awaiting postmortem: ${source.decisions.map((d) => d.title).slice(0, 3).join(" | ") || "none"}
- Today's calendar (high-prep): ${source.calendar.filter((c) => c.prep_priority === "high").map((c) => `${c.title} @ ${new Date(c.start_at).toISOString().slice(11, 16)}`).slice(0, 3).join(" | ") || "none"}
- Slack unread: ${source.slackUnreadCount}
- Cadence-cold contacts: ${source.cadenceColdCount}

Write ONE sentence (<=18 words, lowercase, no greeting).`;

  const { text } = await generateText({
    model: getGeminiModel(),
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
    maxRetries: LLM_MAX_RETRIES,
  });

  return { summary: text.trim() };
}
