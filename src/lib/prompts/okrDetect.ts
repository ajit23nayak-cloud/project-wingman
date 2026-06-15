// OKR detection prompt — single yes/no classification for Notion pages.
//
// Runs as a 2nd LLM call in the classify-pending Notion handler, after the
// standard urgent/important/fyi/archive classification. Output is a single
// boolean stored on notion_pages.is_okr_page.
//
// Schema is intentionally minimal — Gemini gets the title + snippet and
// returns one of two enum values. The extract step (okrExtract.ts) only
// runs when this returns true.

import { generateObject } from "ai";
import { z } from "zod";
import { getGeminiModel, LLM_MAX_RETRIES } from "../llm/gemini";

export const okrDetectSchema = z.object({
  is_okr_page: z.boolean(),
});

export type OKRDetectResult = z.infer<typeof okrDetectSchema>;

const SYSTEM_PROMPT = `You are deciding whether a Notion page is an OKR (Objectives and Key Results) document.

An OKR page contains a structured list of Objectives, each with one or more Key Results — quarterly or annual goals organized in the Objective → KR pattern.

Title hints: "OKR", "Objectives", "Goals 2026", "Q1/Q2/Q3/Q4", "Key Results"
Content hints: bulleted or numbered structure with KR-style progress markers, percentage progress, or red/yellow/green confidence indicators.

NOT an OKR page: project plans, meeting notes, decision docs, personal todos, generic strategy notes without explicit Objective→KR structure, OKR templates with no actual objectives filled in.

Return is_okr_page: true ONLY if the page clearly contains at least one Objective with at least one Key Result. When uncertain, return false.`;

export async function detectOKRPage(input: {
  title: string;
  snippet: string;
}): Promise<{
  result: OKRDetectResult;
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
    schema: okrDetectSchema,
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
