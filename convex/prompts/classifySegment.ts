import { generateObject } from "ai";
import { z } from "zod";
import { getGeminiModel, LLM_MAX_RETRIES } from "../lib/llm";

export const segmentSchema = z.object({
  segment: z.enum([
    "cold_outreach",
    "internal_team",
    "investor_ish",
    "casual_peer",
  ]),
  confidence: z.number().min(0).max(1),
});

export type SegmentResult = z.infer<typeof segmentSchema>;
export type Segment = SegmentResult["segment"];

const BODY_SNIPPET_CHARS = 300;

const SYSTEM_PROMPT = `Classify an email by its conversational register — the relationship between writer and recipient. Four buckets:

cold_outreach — writing to someone you don't know well. Pitchy, formal, often includes case studies / metrics / asks for time. First-touch outbound.

internal_team — writing to people you work with daily (co-founders, employees, contractors). Casual, direct, project-specific. Assumes shared context.

investor_ish — writing to investors, board members, advisors. Professional but personal. Often includes business metrics, updates, asks for warm intros.

casual_peer — writing to friends, mentors, founder-peers you actually know. Informal, warm, may include personal context. Not pitchy.

OUTPUT
Return JSON: { "segment": "<one of the four>", "confidence": <0.0 to 1.0> }
Confidence reflects how clearly the email matches one bucket over the others. Calibrate: 0.9+ when register is unmistakable, 0.6-0.8 when leaning one way, 0.3-0.5 when genuinely ambiguous.

TIE-BREAKER
When two registers fit, pick the one with the higher relational distance (cold_outreach > investor_ish > casual_peer > internal_team). It is safer to draft slightly more formal than too casual.`;

export async function classifySegmentContent(input: {
  subject: string;
  bodyText: string;
}): Promise<{
  result: SegmentResult;
  usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    totalTokens: number | undefined;
  };
}> {
  const body = (input.bodyText ?? "").slice(0, BODY_SNIPPET_CHARS);
  const userPrompt = `Email subject: ${input.subject}
Email body (first ${BODY_SNIPPET_CHARS} chars): ${body}`;

  const { object, usage } = await generateObject({
    model: getGeminiModel(),
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
    schema: segmentSchema,
    maxRetries: LLM_MAX_RETRIES,
  });

  return {
    result: object,
    usage: {
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      totalTokens: usage?.totalTokens,
    },
  };
}
