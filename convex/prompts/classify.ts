import { generateObject } from "ai";
import { z } from "zod";
import { getGeminiModel } from "../lib/llm";

export const classificationSchema = z.object({
  classification: z.enum(["urgent", "important", "fyi", "archive"]),
  reason: z
    .string()
    .describe("8-15 word justification for the classification"),
});

export type ClassificationResult = z.infer<typeof classificationSchema>;

const SYSTEM_PROMPT = `You classify emails into one of four buckets for a busy founder triaging their inbox.

URGENT: needs action TODAY. Real human asking something specific that blocks work, time-sensitive (contracts expiring, customer complaints, calendar conflicts within 24h, fire drills, decisions a teammate is waiting on right now).

IMPORTANT: needs action this week. Real business correspondence requiring response or decision (project updates with asks, intro requests, hiring conversations, vendor decisions, recruiter conversations the founder is engaged with).

FYI: read for context, no action needed (team status updates, high-signal newsletters the founder cares about, account notifications worth knowing about, GitHub or analytics digests).

ARCHIVE: noise (promotional emails, low-signal newsletters, automated notifications without action — payment confirmations after the fact, LinkedIn jobs digest, marketing blasts, social-network digests).

When in doubt between adjacent buckets, lean toward the less urgent one. Never invent action that isn't in the email. Reason field must be 8-15 words explaining the call.`;

export async function classifyEmailContent(email: {
  fromAddress: string;
  subject: string;
  snippet: string;
}): Promise<{
  result: ClassificationResult;
  usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    totalTokens: number | undefined;
  };
}> {
  const userPrompt = `Classify this email:
From: ${email.fromAddress}
Subject: ${email.subject}
Snippet: ${(email.snippet ?? "").slice(0, 500)}`;

  const { object, usage } = await generateObject({
    model: getGeminiModel(),
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
    schema: classificationSchema,
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
