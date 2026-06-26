import { NextRequest, NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// GET /api/audio-briefing/today
//
// Returns today's audio briefing for the current user with a fresh
// signed URL (1h TTL). audio_briefings.audio_path stores the bucket
// path; we mint the URL per request rather than caching it — keeps
// the URL short-lived and immune to bucket-rotation key changes.
//
// Response shapes:
//   { ready: true, audioUrl, durationSeconds, briefingText, generatedAt }
//   { ready: false, status: 'pending' | 'generating' | 'failed' | 'none' }
//
// Browser consumes via useTodaysBriefing — renders the player when
// ready, otherwise shows a fallback message.

export const runtime = "nodejs";

const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1h

export async function GET(req: NextRequest) {
  const resolved = await resolveUser(req);
  if (!resolved.ok) return resolved.response;
  const { supabaseUserId } = resolved.user;

  const today = new Date().toISOString().slice(0, 10);
  const supabase = makeSupabaseServerClient();

  const { data: row, error } = await supabase
    .from("audio_briefings")
    .select("status, briefing_text, audio_path, duration_seconds, generated_at")
    .eq("user_id", supabaseUserId)
    .eq("briefing_date", today)
    .maybeSingle();

  if (error) {
    console.error("[audio-briefing/today] select failed", {
      supabaseUserId,
      message: error.message,
    });
    return NextResponse.json(
      { ready: false, status: "none", error: "select_failed" },
      { status: 500 },
    );
  }

  if (!row) {
    return NextResponse.json({ ready: false, status: "none" });
  }

  const status = (row as { status: string }).status;
  if (status !== "ready") {
    return NextResponse.json({ ready: false, status });
  }

  const audioPath = (row as { audio_path: string | null }).audio_path;
  if (!audioPath) {
    return NextResponse.json({ ready: false, status: "failed" });
  }

  const { data: signed, error: signErr } = await supabase.storage
    .from("audio-briefings")
    .createSignedUrl(audioPath, SIGNED_URL_TTL_SECONDS);

  if (signErr || !signed?.signedUrl) {
    console.error("[audio-briefing/today] sign url failed", {
      supabaseUserId,
      audioPath,
      message: signErr?.message,
    });
    return NextResponse.json(
      { ready: false, status: "failed", error: "sign_failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ready: true,
    audioUrl: signed.signedUrl,
    durationSeconds:
      (row as { duration_seconds: number | null }).duration_seconds ?? null,
    briefingText: (row as { briefing_text: string | null }).briefing_text ?? "",
    generatedAt: (row as { generated_at: string | null }).generated_at,
  });
}
