// Weekly digest prompt. Reads user's last 7 days of activity and produces
// a short HTML body for a Friday email. Gemini for consistency (no
// Anthropic SDK installed — see signal.ts header).

import { generateText } from "ai";
import { getGeminiModel, LLM_MAX_RETRIES } from "./gemini";

export type DigestSource = {
  firstName: string;
  emailsTriaged: number;
  draftsSent: number;
  decisionsLogged: number;
  decisionsAwaitingPostmortem: number;
  reflectionsThisWeek: number;
  topDecisionTitle: string | null;
  topCadenceColdContact: string | null;
};

const SYSTEM_PROMPT = `You write a short Friday-evening weekly digest email for a busy founder. 4-6 short paragraphs, conversational, second person ("you", "your"). Lowercase prose; brand-style sentence-case allowed for the founder's name + specific names. No marketing copy. End with one forward-looking sentence — what to do over the weekend or carry into Monday.

Output: plain HTML body fragment (no <html>, no <head>, no <body>). Use <p> for paragraphs, <strong> for emphasis on counts. NO inline styles. NO links.`;

export async function generateWeeklyDigest(
  source: DigestSource,
): Promise<{ html: string }> {
  const userPrompt = `Hi ${source.firstName}, here's your week:
- Emails triaged: ${source.emailsTriaged}
- Replies drafted + sent via wingman: ${source.draftsSent}
- Decisions logged: ${source.decisionsLogged}
- Decisions awaiting postmortem: ${source.decisionsAwaitingPostmortem}
- Reflections completed: ${source.reflectionsThisWeek} / 5 weekdays
${source.topDecisionTitle ? `- Most recent decision: "${source.topDecisionTitle}"` : ""}
${source.topCadenceColdContact ? `- Cadence-cold reach-out suggestion: ${source.topCadenceColdContact}` : ""}

Write the HTML body now.`;

  const { text } = await generateText({
    model: getGeminiModel(),
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
    maxRetries: LLM_MAX_RETRIES,
  });

  return { html: text.trim() };
}
