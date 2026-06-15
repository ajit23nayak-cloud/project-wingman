// OKR structure extraction — runs only when detectOKRPage returned true.
//
// Extracts Objective → Key Results pairs from a Notion page snippet. Output
// is the okr_structured jsonb on notion_pages. Defensive parsing per Tab 2
// spec point 2: if Gemini returns malformed JSON, the zod schema validation
// throws and the caller in classify-pending logs + stores null without
// failing the whole firing.

import { generateObject } from "ai";
import { z } from "zod";
import { getGeminiModel, LLM_MAX_RETRIES } from "../llm/gemini";

export const okrKeyResultSchema = z.object({
  text: z.string(),
  progress: z.string().nullable().optional(),
  confidence: z.enum(["green", "yellow", "red"]).nullable().optional(),
});

export const okrObjectiveSchema = z.object({
  text: z.string(),
  key_results: z.array(okrKeyResultSchema),
});

export const okrStructuredSchema = z.object({
  quarter: z.string().nullable().optional(),
  objectives: z.array(okrObjectiveSchema),
});

export type OKRStructured = z.infer<typeof okrStructuredSchema>;

const SYSTEM_PROMPT = `Extract Objectives and Key Results from a Notion page snippet.

Return JSON of shape:
{
  "quarter": "Q3 2026" if found in title or content, else null,
  "objectives": [
    {
      "text": "Concise objective statement (max ~80 chars)",
      "key_results": [
        {
          "text": "KR statement",
          "progress": "40%" or "3/5" if explicit progress visible, else null,
          "confidence": "green" / "yellow" / "red" if explicit RAG indicator visible, else null
        }
      ]
    }
  ]
}

Rules:
- Only extract Objectives with at least one Key Result.
- Omit progress / confidence fields when not explicit in the source — do not infer.
- If the snippet is truncated mid-objective, include the partial objective with the KRs you can see.
- If no objectives can be confidently extracted, return objectives: [].`;

export async function extractOKRStructure(input: {
  title: string;
  snippet: string;
}): Promise<{
  result: OKRStructured;
  usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    totalTokens: number | undefined;
  };
}> {
  const userPrompt = `Title: ${input.title}
Snippet: ${(input.snippet ?? "").slice(0, 500)}`;

  const { object, usage } = await generateObject({
    model: getGeminiModel(),
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
    schema: okrStructuredSchema,
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
