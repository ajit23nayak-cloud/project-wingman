import "server-only";

// Google Cloud Text-to-Speech REST wrapper (Commit 19a).
//
// Direct fetch against the v1 synthesize endpoint — avoids pulling in
// @google-cloud/text-to-speech (which would add ~2MB to the cron bundle
// for one call). API key auth (per Tab 2's Mega-C dependency setup,
// log L6479: key restricted to TTS API only).
//
// Voice: en-IN-Wavenet-D (Indian English male, calm pacing). 24kHz MP3
// is the smallest output that still sounds natural — typical 800-char
// script renders as ~50-90KB MP3.

export type TtsOptions = {
  text: string;
  languageCode?: string;
  voiceName?: string;
};

export type TtsResult = {
  audioBuffer: Buffer;
  approxDurationSeconds: number;
};

const TTS_ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize";

export async function synthesizeSpeech(opts: TtsOptions): Promise<TtsResult> {
  const apiKey = process.env.GOOGLE_TTS_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_TTS_API_KEY is not set in the Vercel environment");
  }

  const body = {
    input: { text: opts.text },
    voice: {
      languageCode: opts.languageCode ?? "en-IN",
      name: opts.voiceName ?? "en-IN-Wavenet-D",
    },
    audioConfig: {
      audioEncoding: "MP3",
      sampleRateHertz: 24000,
      // Slightly slower than default for groggy-6am clarity.
      speakingRate: 0.95,
    },
  };

  const res = await fetch(`${TTS_ENDPOINT}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`TTS ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = (await res.json()) as { audioContent?: string };
  if (!data.audioContent) {
    throw new Error("TTS response missing audioContent");
  }

  const audioBuffer = Buffer.from(data.audioContent, "base64");

  // Rough duration estimate: ~150 chars per 60s of speech at speakingRate=0.95.
  // Actual MP3 duration parsing requires a parser dep; this estimate is
  // good enough for the UI label until v1 wires in a real parser.
  const approxDurationSeconds = Math.round((opts.text.length / 150) * 60);

  return { audioBuffer, approxDurationSeconds };
}
