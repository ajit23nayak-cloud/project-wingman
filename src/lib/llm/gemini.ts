// Gemini model singleton for Vercel runtime. Port of convex/lib/llm.ts.
//
// Singleton on the module scope so warm Vercel invocations reuse the same
// provider/model object (createGoogleGenerativeAI is cheap, but reusing
// avoids re-parsing the API key string on every request).
//
// LLM_MAX_RETRIES = 0 — the @ai-sdk default retries 429/QUOTA_EXCEEDED
// 3 times back-to-back, which burns paid-tier quota or hits the free-tier
// per-minute cap during cron bursts. The classify-pending chunk loop
// handles retries out-of-band by leaving status='failed' rows for a future
// "retry failed" cron sweep.

import { createGoogleGenerativeAI } from "@ai-sdk/google";

let _model: ReturnType<ReturnType<typeof createGoogleGenerativeAI>> | null =
  null;

export const LLM_MAX_RETRIES = 0;

export function getGeminiModel() {
  if (_model) return _model;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set in the Vercel environment");
  }
  const provider = createGoogleGenerativeAI({ apiKey });
  _model = provider("gemini-2.5-flash-lite");
  return _model;
}
