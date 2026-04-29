import { action } from "./_generated/server";
import { generateText } from "ai";
import { getGeminiModel } from "./lib/llm";

export const testGemini = action({
  args: {},
  handler: async (): Promise<{ text: string; error?: string }> => {
    try {
      const { text } = await generateText({
        model: getGeminiModel(),
        prompt: "Reply with exactly: hello from gemini",
      });
      return { text };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[testGemini] Gemini call failed", { error: message });
      return { text: "", error: message };
    }
  },
});
