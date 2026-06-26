import { NextRequest, NextResponse } from "next/server";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import { generateBriefingScript, type BriefingSource } from "@/lib/llm/briefing";
import { synthesizeSpeech } from "@/lib/google/tts";

// POST /api/cron/generate-briefing
//
// pg_cron target (every hour at :30 per migration 0026). For each active
// user whose local hour is currently 6, generates a morning briefing:
//   1. Aggregate last-24h urgent emails + decisions + today's calendar
//      + slack unread + cadence-cold contacts + today's signal
//   2. Gemini script (600-900 char prose)
//   3. Google TTS WaveNet en-IN-Wavenet-D MP3
//   4. Upload to Supabase Storage `audio-briefings/<userId>/<date>.mp3`
//   5. Upsert audio_briefings row with status='ready' + audio_path
//
// Per-user try/catch — one failure doesn't poison the batch. Skips users
// who already have a ready briefing for today (unique constraint dedupe).

export const runtime = "nodejs";
export const maxDuration = 60;

type EligibleUser = {
  id: string;
  email: string;
  timezone: string | null;
};

function localHourFor(tz: string | null): number | null {
  const zone = tz ?? "Asia/Kolkata";
  try {
    return parseInt(
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hour: "2-digit",
        hour12: false,
      }).format(new Date()),
      10,
    );
  } catch {
    return null;
  }
}

function firstNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "there";
  const [first] = local.split(/[._-]/);
  if (!first) return "there";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

export async function POST(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!expected || authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = makeSupabaseServerClient();
  const startedAt = Date.now();

  // Pull active-in-last-7-days users (briefings only matter for users
  // actually checking the dashboard).
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: users, error: usersErr } = await supabase
    .from("users")
    .select("id, email, timezone")
    .gte("last_dashboard_open_at", cutoff);

  if (usersErr) {
    console.error("[generate-briefing] users select failed", {
      message: usersErr.message,
    });
    return NextResponse.json({ ok: false, error: "users_select_failed" });
  }

  const eligible: EligibleUser[] = ((users ?? []) as EligibleUser[]).filter(
    (u) => localHourFor(u.timezone) === 6,
  );

  let generated = 0;
  let skipped = 0;
  let failed = 0;
  const samples: Array<{ user_id: string; chars: number }> = [];

  for (const user of eligible) {
    const today = new Date().toISOString().slice(0, 10);
    try {
      // Skip if today's briefing already exists in ready state.
      const { data: existing } = await supabase
        .from("audio_briefings")
        .select("status")
        .eq("user_id", user.id)
        .eq("briefing_date", today)
        .maybeSingle();
      if (existing && (existing as { status: string }).status === "ready") {
        skipped += 1;
        continue;
      }

      // Stamp generating so a re-fire mid-run doesn't double-generate.
      await supabase.from("audio_briefings").upsert(
        {
          user_id: user.id,
          briefing_date: today,
          status: "generating",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,briefing_date" },
      );

      const source = await loadBriefingSource(supabase, user.id, user.email);
      const { script } = await generateBriefingScript(source);

      if (!script || script.length < 100) {
        throw new Error(`script_too_short: ${script.length} chars`);
      }

      const { audioBuffer, approxDurationSeconds } = await synthesizeSpeech({
        text: script,
      });

      const audioPath = `${user.id}/${today}.mp3`;
      const { error: upErr } = await supabase.storage
        .from("audio-briefings")
        .upload(audioPath, audioBuffer, {
          contentType: "audio/mpeg",
          upsert: true,
        });
      if (upErr) {
        throw new Error(`storage_upload: ${upErr.message}`);
      }

      const { error: updateErr } = await supabase
        .from("audio_briefings")
        .update({
          briefing_text: script,
          audio_path: audioPath,
          duration_seconds: approxDurationSeconds,
          status: "ready",
          generated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", user.id)
        .eq("briefing_date", today);
      if (updateErr) {
        throw new Error(`row_update: ${updateErr.message}`);
      }

      generated += 1;
      if (samples.length < 3) samples.push({ user_id: user.id, chars: script.length });
    } catch (err) {
      failed += 1;
      console.error("[generate-briefing] per-user failed", {
        user_id: user.id,
        message: err instanceof Error ? err.message : String(err),
      });
      await supabase
        .from("audio_briefings")
        .update({
          status: "failed",
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", user.id)
        .eq("briefing_date", today);
    }
  }

  return NextResponse.json({
    ok: true,
    scanned: users?.length ?? 0,
    in6amWindow: eligible.length,
    generated,
    skipped,
    failed,
    samples,
    elapsedMs: Date.now() - startedAt,
  });
}

async function loadBriefingSource(
  supabase: ReturnType<typeof makeSupabaseServerClient>,
  userId: string,
  email: string,
): Promise<BriefingSource> {
  const since24h = Date.now() - 24 * 60 * 60 * 1000;

  const { data: urgentEmails } = await supabase
    .from("emails")
    .select("subject, from_address")
    .eq("user_id", userId)
    .eq("classification", "urgent")
    .gte("received_at", since24h)
    .order("received_at", { ascending: false })
    .limit(5);

  const { data: decisions } = await supabase
    .from("decisions")
    .select("title")
    .eq("user_id", userId)
    .eq("status", "postmortem_due")
    .limit(3);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  const { data: calendar } = await supabase
    .from("calendar_events")
    .select("title, start_at, prep_priority")
    .eq("user_id", userId)
    .eq("event_status", "confirmed")
    .gte("start_at", todayStart.toISOString())
    .lt("start_at", todayEnd.toISOString())
    .order("start_at", { ascending: true })
    .limit(5);

  const { count: slackUnreadCount } = await supabase
    .from("slack_messages")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("classification", "urgent");

  const { data: coldContacts } = await supabase
    .from("contacts")
    .select("display_name")
    .eq("user_id", userId)
    .gte("cadence_break_days", 28)
    .eq("archived", false)
    .order("cadence_break_days", { ascending: false })
    .limit(3);

  // Pick the latest dashboard_signal in the last 60 min, if any.
  const since60min = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: signal } = await supabase
    .from("dashboard_signals")
    .select("summary_text")
    .eq("user_id", userId)
    .gte("generated_at", since60min)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    firstName: firstNameFromEmail(email),
    urgentEmails: (urgentEmails ?? []) as BriefingSource["urgentEmails"],
    decisionsAwaitingPostmortem:
      (decisions ?? []) as BriefingSource["decisionsAwaitingPostmortem"],
    calendarToday: (calendar ?? []) as BriefingSource["calendarToday"],
    slackUnreadCount: slackUnreadCount ?? 0,
    cadenceColdContacts:
      (coldContacts ?? []) as BriefingSource["cadenceColdContacts"],
    todaysSignal:
      (signal as { summary_text: string } | null)?.summary_text ?? null,
  };
}
