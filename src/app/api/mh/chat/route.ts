import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { auth } from "@clerk/nextjs/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import { getGeminiModel, LLM_MAX_RETRIES } from "@/lib/llm/gemini";
import { buildChatSystemPrompt } from "@/lib/mh/chatPrompt";
import { CHAT_TRANSCRIPT_MAX_TURNS } from "@/lib/mh/helpMeThink";
import { screenForSafety } from "@/lib/mh/safety/screen";
import { regionFromClaims, regionFromTimezone } from "@/lib/mh/safety/regionDetect";
import { escalationScript, type Region } from "@/lib/mh/safety/resources";
import { logEscalation } from "@/lib/mh/safety/log";
import type { MhStyle } from "@/lib/supabase/hooks";

// POST /api/mh/chat
//
// Per-turn LLM call for the chat fallback route in "Help me think." Does
// NOT persist to mh_sessions — the client posts the full final transcript
// to /api/mh/on_demand at session-end.
//
// COMMIT F SAFETY FLOW (replaces Commit D's inline minimal safety):
//   1. Region detect from Clerk session timezone, default IN.
//   2. Layer 1 regex screen on the user's latest message (transcript tail).
//      If triggered → return the escalation script as the assistant message
//      WITHOUT calling the LLM. Log via safety/log.ts (DB + PostHog).
//   3. If regex passes → call LLM with system prompt that includes the
//      SAFETY block (Layer 2). LLM honors the same escalation rules for
//      phrases the regex missed.
//   4. Detecting Layer 2 escalation is best-effort: if the LLM's response
//      matches the escalation script text, log it as detection_layer=llm.
//
// Turn cap unchanged: max 4 user turns (8 total messages).

export const runtime = "nodejs";

type TranscriptMessage = { role: "user" | "assistant"; content: string };
type RequestBody = { transcript?: unknown };

const ASSISTANT_RESPONSE_MAX_CHARS = 600;

// Used to detect when the LLM (Layer 2) produced the escalation script.
// Match on the verbatim opening sentence — it's specific enough to not
// false-positive on coaching responses + simple enough to survive minor
// LLM whitespace/punctuation drift.
const ESCALATION_OPENING = "this is bigger than what i'm built for";

function llmOutputIsEscalation(text: string): boolean {
  return text.toLowerCase().includes(ESCALATION_OPENING);
}

// App-level retry wrapper for the Gemini generateText call. We keep the
// SDK-level maxRetries at 0 (see LLM_MAX_RETRIES) so this stays the only
// retry control plane. Backoff: 800ms, 1.6s — total worst case ~2.4s
// before user sees an error, well inside the chat UX patience window.
//
// Only retry on transient signals (network blip / 5xx / quota) — validation
// or model-format errors get surfaced immediately so the user can rephrase.
async function generateTextWithRetry(
  args: Parameters<typeof generateText>[0],
  maxRetries = 2,
) {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await generateText(args);
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      // Don't retry on validation-style errors — only transient network/quota.
      const transient =
        /timeout|fetch|network|ECONN|5\d\d|429|UNAVAILABLE|RESOURCE_EXHAUSTED/i.test(
          message,
        );
      if (!transient || attempt === maxRetries) throw err;
      // Exponential backoff: 800ms, 1.6s
      await new Promise((r) => setTimeout(r, 800 * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

export async function POST(req: NextRequest) {
  const result = await resolveUser(req);
  if (!result.ok) return result.response;
  const { supabaseUserId } = result.user;

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "bad_request" },
      { status: 400 },
    );
  }

  if (!Array.isArray(body.transcript) || body.transcript.length === 0) {
    return NextResponse.json(
      { ok: false, error: "empty_transcript" },
      { status: 400 },
    );
  }

  const transcript: TranscriptMessage[] = [];
  for (const entry of body.transcript) {
    if (!entry || typeof entry !== "object") {
      return NextResponse.json(
        { ok: false, error: "transcript_entry_not_object" },
        { status: 400 },
      );
    }
    const e = entry as { role?: unknown; content?: unknown };
    if (e.role !== "user" && e.role !== "assistant") {
      return NextResponse.json(
        { ok: false, error: "transcript_entry_invalid_role" },
        { status: 400 },
      );
    }
    if (typeof e.content !== "string" || e.content.trim().length === 0) {
      return NextResponse.json(
        { ok: false, error: "transcript_entry_empty_content" },
        { status: 400 },
      );
    }
    transcript.push({ role: e.role, content: e.content.slice(0, 4000) });
  }

  const lastMsg = transcript[transcript.length - 1];
  if (lastMsg.role !== "user") {
    return NextResponse.json(
      { ok: false, error: "transcript_must_end_with_user" },
      { status: 400 },
    );
  }

  const userMessageCount = transcript.filter((m) => m.role === "user").length;
  if (userMessageCount > CHAT_TRANSCRIPT_MAX_TURNS / 2) {
    return NextResponse.json(
      { ok: false, error: "turn_cap_reached" },
      { status: 400 },
    );
  }

  // Region detection from Clerk session claims. Default IN inside
  // regionFromClaims if claim missing.
  const session = await auth();
  let region: Region = regionFromClaims(
    session.sessionClaims as Record<string, unknown> | null | undefined,
  );
  // Belt-and-suspenders: also accept a `timezone` body field. Useful for
  // CLI tests + lets the client pass `Intl.DateTimeFormat().resolvedOptions().timeZone`
  // when Clerk doesn't surface it in claims.
  const bodyTz = (body as { timezone?: unknown }).timezone;
  if (typeof bodyTz === "string") {
    region = regionFromTimezone(bodyTz);
  }

  const supabase = makeSupabaseServerClient();

  // LAYER 1: regex pre-LLM screen on the latest user message. If triggered,
  // short-circuit before the LLM call.
  const screen = screenForSafety(lastMsg.content);
  if (screen.triggered) {
    const script = escalationScript(region);
    // Fire-and-forget log; don't block the response on it.
    void logEscalation(supabase, {
      supabaseUserId,
      region,
      sourceRoute: "mh_chat",
      detectionLayer: "regex",
    });
    return NextResponse.json({
      ok: true,
      assistantMessage: script,
      turnsUsed: userMessageCount,
      escalation: { triggered: true, layer: "regex", category: screen.category },
    });
  }

  // Layer 1 passed — call LLM with the Layer 2 SAFETY block embedded.
  const { data: userRow } = await supabase
    .from("users")
    .select("mh_style")
    .eq("id", supabaseUserId)
    .single();
  const mhStyle = (userRow?.mh_style as MhStyle | null) ?? null;

  const systemPrompt = buildChatSystemPrompt(mhStyle, region);

  try {
    const { text } = await generateTextWithRetry({
      model: getGeminiModel(),
      system: systemPrompt,
      messages: transcript.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      maxRetries: LLM_MAX_RETRIES,
    });
    const assistantMessage = (text ?? "")
      .trim()
      .slice(0, ASSISTANT_RESPONSE_MAX_CHARS);
    if (assistantMessage.length === 0) {
      return NextResponse.json(
        { ok: false, error: "empty_assistant_response" },
        { status: 502 },
      );
    }

    // LAYER 2: detect if the LLM produced the escalation script itself.
    // Log as detection_layer='llm' so v1 can compare layer coverage.
    const isLlmEscalation = llmOutputIsEscalation(assistantMessage);
    if (isLlmEscalation) {
      void logEscalation(supabase, {
        supabaseUserId,
        region,
        sourceRoute: "mh_chat",
        detectionLayer: "llm",
      });
    }

    return NextResponse.json({
      ok: true,
      assistantMessage,
      turnsUsed: userMessageCount,
      escalation: isLlmEscalation
        ? { triggered: true, layer: "llm" }
        : { triggered: false },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[mh/chat] LLM call failed after retries", {
      supabaseUserId,
      message,
    });
    // Classify the error for the client so the UI can render a useful message
    // instead of the generic "llm_failed". v0 categories:
    //   - llm_quota: 429 / RESOURCE_EXHAUSTED — Gemini rate-limit / quota
    //   - llm_timeout: timeout / ECONNRESET / fetch failed
    //   - llm_failed: everything else (genuine model error, parse failure)
    const errorCode =
      /429|RESOURCE_EXHAUSTED|quota/i.test(message)
        ? "llm_quota"
        : /timeout|ECONN|fetch|network/i.test(message)
          ? "llm_timeout"
          : "llm_failed";
    // Conversational fallback for the client to render directly.
    const userMessage =
      errorCode === "llm_quota"
        ? "we're getting a lot of traffic right now — try again in a minute."
        : errorCode === "llm_timeout"
          ? "that took longer than expected — try once more."
          : "hmm, that didn't land. try rephrasing or hit reset.";
    return NextResponse.json(
      { ok: false, error: errorCode, userMessage },
      { status: 502 },
    );
  }
}
