import { generateText } from "ai";
import { getGeminiModel } from "../lib/llm";

const BODY_MAX_CHARS = 1500;

function buildSystemPrompt(userFirstName: string, voiceSnippets: string[]): string {
  const personHeader =
    userFirstName === "there"
      ? `You are drafting a reply on the user's behalf.`
      : `You are drafting a reply on behalf of ${userFirstName}.`;

  const voicePrime =
    voiceSnippets.length > 0
      ? `Match their voice based on these recent reply samples:\n${voiceSnippets.join("\n---\n")}`
      : `No prior reply samples available — write in a natural, professional, concise tone.`;

  return `${personHeader} ${voicePrime}

Length: under 100 words unless thread context demands more.

Output rules — these are non-negotiable:
- Output ONLY the reply body. No "Sure, here's a draft:", no preamble of any kind.
- Do NOT include a sign-off line. No "Best,", "Thanks,", "Regards,", "Cheers,", or anything followed by a name. The user appends their own.
- Do NOT include placeholders like [Your Name], [Name], [Company], or any bracketed instructions.
- Do NOT include a subject line or quoted history.
- Do NOT start with "Hi [name]" if the recipient name isn't obvious from the email metadata.`;
}

function buildUserPrompt(input: {
  fromAddress: string;
  subject: string;
  bodyText: string;
}): string {
  const body = (input.bodyText ?? "").slice(0, BODY_MAX_CHARS);
  return `Draft a reply to this email:
From: ${input.fromAddress}
Subject: ${input.subject}
Body: ${body}

Let the reply intent (acknowledging only / request info / propose next step / decline politely / etc.) be inferred from the email content.`;
}

export async function draftReplyContent(input: {
  userFirstName: string;
  voiceSnippets: string[];
  fromAddress: string;
  subject: string;
  bodyText: string;
}): Promise<{
  text: string;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}> {
  const system = buildSystemPrompt(input.userFirstName, input.voiceSnippets);
  const prompt = buildUserPrompt({
    fromAddress: input.fromAddress,
    subject: input.subject,
    bodyText: input.bodyText,
  });

  const { text, usage } = await generateText({
    model: getGeminiModel(),
    system,
    prompt,
  });

  return {
    text: (text ?? "").trim(),
    usage: {
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      totalTokens: usage?.totalTokens,
    },
  };
}
