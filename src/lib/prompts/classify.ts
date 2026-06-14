// Email classifier prompt + schema. Verbatim port of convex/prompts/classify.ts
// — DO NOT diverge without re-running Tab 2's classify-smoke-test.mjs harness.
// The prompt was hand-tuned against the founder's actual inbox; a copy-edit
// here can move the rule-1-wins ordering and re-shuffle thousands of
// classifications.
//
// Output schema is a tight zod object. The `reason` field is constrained
// 8-15 words in the prompt; we don't enforce that in zod (the model honors
// it well enough that adding a regex check trades reliability for noise).

import { generateObject } from "ai";
import { z } from "zod";
import { getGeminiModel, LLM_MAX_RETRIES } from "../llm/gemini";

export const classificationSchema = z.object({
  classification: z.enum(["urgent", "important", "fyi", "archive"]),
  reason: z
    .string()
    .describe("8-15 word justification for the classification"),
});

export type ClassificationResult = z.infer<typeof classificationSchema>;

const SYSTEM_PROMPT = `You classify emails into one of four buckets for a busy founder triaging their inbox: urgent, important, fyi, archive.

THE BUCKETS

URGENT — action needed in the next 24 hours, or the founder loses something.
IMPORTANT — matters to the business or to the founder's life, but not 24h-urgent.
FYI — useful to know, no action required.
ARCHIVE — no value, can be auto-deleted.

DECISION RULES (apply top to bottom — the first matching rule wins)

1. mailer-daemon / postmaster delivery-failure bounces on a thread the founder SENT → URGENT.
   The founder lost a lead and needs to resend today.

2. Infra billing or usage warnings from Convex, Vercel, AWS, Google Cloud, GitHub, Cloudflare, Render, Fly.io, Supabase:
   - If subject or body contains "action required", "plan exceeded", "service will be suspended", "upgrade required", "card declined" → URGENT.
   - Otherwise (e.g. "approaching 80% of quota", "monthly usage report") → IMPORTANT.

3. Account verification with a stated deadline (KYC, identity verification, domain renewal, tax form):
   - Deadline within 60 days → URGENT.
   - Deadline beyond 60 days → IMPORTANT.

4. Email's From address matches the founder's own address (provided in the user message as "Founder's email") → IMPORTANT.
   This is the founder's own outbound pitch / outreach showing up in inbox for pipeline tracking — they want to see it but it is not 24h-urgent.

5. Active community / cohort / accelerator updates that the founder is a current member of (GrowthX, YC, On Deck, South Park Commons, founder-Slack-style groups) — event lineups, weekly threads, member intros → IMPORTANT.
   Generic event blasts the founder has no relationship with → FYI or ARCHIVE.

6. A real human reply on a thread the founder initiated (someone responding to outreach, intros, hiring conversations, vendor conversations the founder is actively engaged with), with an explicit ask or decision needed → IMPORTANT.

7. Security codes / OTPs / 2FA codes / magic-sign-in links sent because the founder just triggered a login → ARCHIVE.
   They auto-expire in minutes and a fresh one can be requested on demand. There is nothing to do AFTER the code arrives.
   Exception: a security alert about activity the founder did NOT initiate (suspicious sign-in from unknown device, password changed by someone else, account compromise notice) → URGENT.

8. Unsolicited cold asks from peers — "looking for 15 min of feedback", "quick call?", "can I pick your brain", "would love your thoughts on my product" from someone the founder does not have an active relationship with → ARCHIVE.

9. Job alerts from LinkedIn / Naukri / Indeed / Glassdoor / Google Jobs / Hired → ARCHIVE.
   The founder is not job-hunting.

10. Automated transaction receipts and after-the-fact confirmations — Uber, Ola, Rapido, HDFC / ICICI / SBI / Axis UPI alerts, Razorpay / Stripe / PayPal receipts, Swiggy / Zomato order confirmations, Amazon / Flipkart shipping updates, airline / hotel booking confirmations → ARCHIVE.
   Exception: payment FAILED / card DECLINED / fraud alert → URGENT.

11. Marketing / promotional emails from brands (Samsung, Air India, hotel chains, retail, SaaS product update blasts the founder has no engagement with) → ARCHIVE.

12. AI / industry / finance / tech newsletters and digests the founder subscribed to (Substack-style, weekly roundups, market summaries, Zerodha weekly equity statement, brokerage portfolio summaries) → FYI.

13. Workshop / webinar / event RSVPs with no commitment ("free workshop tomorrow, drop in if you can") → FYI.

14. Alumni network / school / professional-association updates with no specific ask → FYI.

TIE-BREAKERS
- When two rules apply, the lower-numbered rule wins (the table is priority-ordered).
- When genuinely torn between two adjacent buckets, pick the less urgent one.
- Never invent action that is not in the email.

REASON FIELD
8 to 15 words. Lead with the signal you used. Examples: "Bounced outreach on founder-sent thread — needs resend today." or "Greenhouse OTP, auto-expires, no action required."

FEW-SHOT EXAMPLES

1) From: mailer-daemon@googlemail.com
   Subject: Delivery Status Notification (Failure)
   Snippet: Your message to chaitra.kr@loophealth.com could not be delivered.
   Founder's email: hsaritha13@gmail.com
   → { "classification": "urgent", "reason": "Bounce on founder-sent outreach to Loop Health — resend today." }

2) From: support@convex.dev
   Subject: Your team needs to upgrade their plan
   Snippet: Your Convex team has exceeded the free-tier limits. Service will be suspended unless you upgrade.
   Founder's email: hsaritha13@gmail.com
   → { "classification": "urgent", "reason": "Convex plan exceeded with suspension risk — infra blocker, act today." }

3) From: ajit nayak <hsaritha13@gmail.com>
   Subject: Quick intro — Wingman x Loop Health
   Snippet: Hi Chaitra, hope this finds you well. Quick note to share what we're building at Wingman.
   Founder's email: hsaritha13@gmail.com
   → { "classification": "important", "reason": "Founder's own self-sent outbound pitch — pipeline tracking, not 24h-urgent." }

4) From: no-reply@greenhouse.io
   Subject: Your Greenhouse security code is c22sCnX0
   Snippet: Use this code to sign in. It will expire in 10 minutes.
   Founder's email: hsaritha13@gmail.com
   → { "classification": "archive", "reason": "Login OTP auto-expires and is re-requestable on demand — no action." }

5) From: Jacob @ Relay.app <jacob@relay.app>
   Subject: Looking for 15 min of feedback on Relay
   Snippet: Hey — building Relay.app and would love 15 minutes of your feedback this week.
   Founder's email: hsaritha13@gmail.com
   → { "classification": "archive", "reason": "Unsolicited peer cold-ask for feedback time — no prior relationship." }`;

// `usage` from generateObject is observed to come back as
// `{ inputTokens?: number, outputTokens?: number, totalTokens?: number }`
// with all fields optional. We propagate the optionality up to callers.
//
// Multi-source classification: same SYSTEM_PROMPT for Gmail emails, Slack
// DMs, and Notion page edits, but the USER prompt is source-shaped. Each
// non-Gmail source gets a brief source-context preface telling the model
// that most email-specific decision rules don't apply and to fall through
// to first-principles framing for that source. Per Tab 2's Commit 4 lock:
// "single classifier with source-aware prompt addendum" — don't fork the
// system prompt.
export type ClassifyInput =
  | {
      source: "gmail";
      fromAddress: string;
      subject: string;
      snippet: string;
      userEmail: string;
    }
  | {
      source: "slack";
      senderName: string | null;
      senderId: string;
      channelId: string;
      text: string;
      userEmail: string;
    }
  | {
      source: "notion";
      pageTitle: string;
      snippet: string;
      lastEditedAt: string;
      userEmail: string;
    };

export async function classifyContent(input: ClassifyInput): Promise<{
  result: ClassificationResult;
  usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    totalTokens: number | undefined;
  };
}> {
  let userPrompt: string;
  if (input.source === "gmail") {
    userPrompt = `Classify this email:
From: ${input.fromAddress}
Subject: ${input.subject}
Snippet: ${(input.snippet ?? "").slice(0, 500)}
Founder's email: ${input.userEmail}`;
  } else if (input.source === "slack") {
    const sender = input.senderName ?? input.senderId;
    userPrompt = `Classify this Slack DM.

SOURCE CONTEXT: This is a 1:1 Slack direct message, not an email. The decision rules above are email-centric — most won't apply to DMs (no mailer-daemon bounces, no infra billing emails, no OTPs, no marketing blasts, no LinkedIn job alerts in 1:1 DMs). Fall through to first-principles framing:

- URGENT: explicit ask with a same-day or next-24h deadline; an active thread waiting on the founder's reply to unblock someone; a 1:1 ping from a co-founder / investor / customer about a live issue.
- IMPORTANT: a real conversation requiring a thoughtful reply, but not 24h-urgent; pipeline / hiring / customer threads the founder is in.
- FYI: status updates, FYI-style pings, links shared with no ask.
- ARCHIVE: bot messages, automated notifications routed to DMs, casual one-liners with no follow-up needed.

DM:
From: ${sender}
Channel: ${input.channelId}
Message: ${input.text.slice(0, 500)}
Founder's email: ${input.userEmail}`;
  } else {
    userPrompt = `Classify this Notion page edit.

SOURCE CONTEXT: This is a Notion page (or page edit notification), not an email or a 1:1 DM. The decision rules above are email-centric — most don't directly apply. Notion content is project / planning / writing context. Fall through to:

- URGENT: a page the founder needs to action TODAY (status updates from co-founder marked decision-pending, urgent project notes, deadlines in the page body).
- IMPORTANT: meaningful project work — investor updates, hiring pipeline, customer call notes, decision documents that the founder is the writer or reader of.
- FYI: passive context the founder maintains — note templates, archive material, completed work logs.
- ARCHIVE: stale templates, exported content with no project relevance, automated journal entries.

PAGE:
Title: ${input.pageTitle}
Last edited: ${input.lastEditedAt}
Snippet: ${input.snippet.slice(0, 500)}
Founder's email: ${input.userEmail}`;
  }

  const { object, usage } = await generateObject({
    model: getGeminiModel(),
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
    schema: classificationSchema,
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
