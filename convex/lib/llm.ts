import { createGoogleGenerativeAI } from "@ai-sdk/google";

let _model: ReturnType<ReturnType<typeof createGoogleGenerativeAI>> | null =
  null;

export function getGeminiModel() {
  if (_model) return _model;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set in the Convex environment");
  }
  const provider = createGoogleGenerativeAI({ apiKey });
  _model = provider("gemini-2.5-flash");
  return _model;
}
