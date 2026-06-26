import { NextRequest, NextResponse } from "next/server";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import { generateTodaysSignal, type SignalSource } from "@/lib/llm/signal";

// POST /api/cron/dashboard-signal-refresh
//
// pg_cron target (every hour at :10). Migration 0025 registered this URL
// path verbatim (cron job name = URL slug). Caps Gemini spend by only
// generating signals for users active in the last 24h.
//
// For each eligible user: aggregate today's data → Gemini one-sentence
// summary → insert dashboard_signals row. Reader (useTodaysSignal hook)
// picks the latest row generated in the last 60 min.

export const runtime = "nodejs";
export const maxDuration = 60;

type ActiveUser = {
  id: string;
  email: string;
  last_dashboard_open_at: string | null;
};

export async function POST(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!expected || authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = makeSupabaseServerClient();
  const startedAt = Date.now();

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: users, error: usersErr } = await supabase
    .from("users")
    .select("id, email, last_dashboard_open_at")
    .gte("last_dashboard_open_at", cutoff);

  if (usersErr) {
    console.error("[dashboard-signal-refresh] users select failed", {
      message: usersErr.message,
    });
    return NextResponse.json({ ok: false, error: "users_select_failed" });
  }

  const eligible = (users ?? []) as ActiveUser[];
  let generated = 0;
  let failed = 0;
  const samples: Array<{ user_id: string; summary: string }> = [];

  for (const user of eligible) {
    try {
      const source = await loadSignalSource(supabase, user.id);
      const { summary } = await generateTodaysSignal(source);
      if (!summary) {
        failed += 1;
        continue;
      }
      const { error: insErr } = await supabase
        .from("dashboard_signals")
        .insert({
          user_id: user.id,
          summary_text: summary,
          source_counts: {
            emails: source.emails.length,
            decisions: source.decisions.length,
            calendar: source.calendar.length,
            slack: source.slackUnreadCount,
            cadence: source.cadenceColdCount,
          },
        });
      if (insErr) {
        failed += 1;
        console.error("[dashboard-signal-refresh] insert failed", {
          user_id: user.id,
          message: insErr.message,
        });
      } else {
        generated += 1;
        if (samples.length < 3) samples.push({ user_id: user.id, summary });
      }
    } catch (err) {
      failed += 1;
      console.error("[dashboard-signal-refresh] generate failed", {
        user_id: user.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    eligible: eligible.length,
    generated,
    failed,
    samples,
    elapsedMs: Date.now() - startedAt,
  });
}

async function loadSignalSource(
  supabase: ReturnType<typeof makeSupabaseServerClient>,
  userId: string,
): Promise<SignalSource> {
  const since24h = Date.now() - 24 * 60 * 60 * 1000;

  const { data: emails } = await supabase
    .from("emails")
    .select("subject, classification, received_at")
    .eq("user_id", userId)
    .gte("received_at", since24h)
    .order("received_at", { ascending: false })
    .limit(20);

  const { data: decisions } = await supabase
    .from("decisions")
    .select("title, postmortem_due_at")
    .eq("user_id", userId)
    .eq("status", "postmortem_due")
    .limit(10);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  const { data: calendar } = await supabase
    .from("calendar_events")
    .select("title, prep_priority, start_at")
    .eq("user_id", userId)
    .eq("event_status", "confirmed")
    .gte("start_at", todayStart.toISOString())
    .lt("start_at", todayEnd.toISOString())
    .limit(20);

  const { count: slackUnreadCount } = await supabase
    .from("slack_messages")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("classification", "urgent");

  const { count: cadenceColdCount } = await supabase
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("cadence_break_days", 28)
    .eq("archived", false);

  return {
    emails: (emails ?? []) as SignalSource["emails"],
    decisions: (decisions ?? []) as SignalSource["decisions"],
    calendar: (calendar ?? []) as SignalSource["calendar"],
    slackUnreadCount: slackUnreadCount ?? 0,
    cadenceColdCount: cadenceColdCount ?? 0,
  };
}
