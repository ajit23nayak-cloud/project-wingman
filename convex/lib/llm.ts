import { createGoogleGenerativeAI } from "@ai-sdk/google";

let _model: ReturnType<ReturnType<typeof createGoogleGenerativeAI>> | null =
  null;

// Why 0: the AI SDK's default retry treats 429 / QUOTA_EXCEEDED as retryable
// and fires 3 attempts back-to-back. On the free tier that just burns the
// remaining quota and turns one rejection into three. The chunk loop's
// "retry failed" mode handles transient errors out-of-band, so call-site
// retries inside generateObject add no value.
export const LLM_MAX_RETRIES = 0;

export function getGeminiModel() {
  if (_model) return _model;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set in the Convex environment");
  }
  const provider = createGoogleGenerativeAI({ apiKey });
  _model = provider("gemini-2.5-flash-lite");
  return _model;
}
