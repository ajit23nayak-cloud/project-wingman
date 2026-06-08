import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import { getGeminiModel, LLM_MAX_RETRIES } from "@/lib/llm/gemini";
import { buildChatSystemPrompt } from "@/lib/mh/chatPrompt";
import { CHAT_TRANSCRIPT_MAX_TURNS } from "@/lib/mh/helpMeThink";
import type { MhStyle } from "@/lib/supabase/hooks";

// POST /api/mh/chat
//
// Per-turn LLM call for the chat fallback route in "Help me think." Does
// NOT persist to mh_sessions — the client posts the full final transcript
// to /api/mh/on_demand at session-end. Each turn just gets the assistant's
// response.
//
// Body: { transcript: [{role: 'user' | 'assistant', content: string}] }
//   - The transcript ENDS with the user's latest message (client appends
//     the user msg locally before calling /chat).
// Returns: { ok: true, assistantMessage: string } on success
//          { ok: false, error: 'turn_cap_reached' | 'llm_failed' | ... }
//
// Turn cap (Tab 2 lock + Ajit confirm): MAX 8 messages total (4 user + 4
// assistant). After the 4th assistant response, client renders the hard
// stop UI. Server enforces too — refuses LLM call past the cap.

export const runtime = "nodejs";

type TranscriptMessage = { role: "user" | "assistant"; content: string };
type RequestBody = { transcript?: unknown };

const ASSISTANT_RESPONSE_MAX_CHARS = 600;

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

  // Validate transcript shape + end-with-user.
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

  if (transcript[transcript.length - 1].role !== "user") {
    return NextResponse.json(
      { ok: false, error: "transcript_must_end_with_user" },
      { status: 400 },
    );
  }

  // Turn cap. After the 4th user message + 4th assistant message =
  // transcript.length = 8 and the LAST message is assistant. The user's
  // 5th message would push us to length 9 — refuse.
  const userMessageCount = transcript.filter((m) => m.role === "user").length;
  if (userMessageCount > CHAT_TRANSCRIPT_MAX_TURNS / 2) {
    return NextResponse.json(
      { ok: false, error: "turn_cap_reached" },
      { status: 400 },
    );
  }

  // Fetch user's style for system prompt.
  const supabase = makeSupabaseServerClient();
  const { data: userRow } = await supabase
    .from("users")
    .select("mh_style")
    .eq("id", supabaseUserId)
    .single();
  const mhStyle = (userRow?.mh_style as MhStyle | null) ?? null;

  const systemPrompt = buildChatSystemPrompt(mhStyle);

  try {
    const { text } = await generateText({
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
    return NextResponse.json({
      ok: true,
      assistantMessage,
      turnsUsed: userMessageCount,
    });
  } catch (err) {
    console.error("[mh/chat] LLM call failed", {
      supabaseUserId,
      message: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: "llm_failed" },
      { status: 502 },
    );
  }
}
