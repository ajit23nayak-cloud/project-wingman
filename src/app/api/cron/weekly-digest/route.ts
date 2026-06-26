import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import { generateWeeklyDigest, type DigestSource } from "@/lib/llm/digest";

// POST /api/cron/weekly-digest
//
// pg_cron target (Friday 17:00 UTC = 22:30 IST). Walks active users from
// the last 14 days, aggregates their 7-day activity, generates a Gemini
// HTML body, sends via Resend. Per-user try/catch — one failure doesn't
// poison the batch.

export const runtime = "nodejs";
export const maxDuration = 60;

type ActiveUser = {
  id: string;
  email: string;
  // Derive firstName from local-part if not stored separately
};

function firstNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "there";
  // Title-case the first dot-segment: "ajit.nayak" -> "Ajit"
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

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return NextResponse.json(
      { ok: false, error: "RESEND_API_KEY missing" },
      { status: 500 },
    );
  }
  const resend = new Resend(resendKey);

  const supabase = makeSupabaseServerClient();
  const startedAt = Date.now();
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data: users, error: usersErr } = await supabase
    .from("users")
    .select("id, email")
    .gte("last_dashboard_open_at", cutoff);

  if (usersErr) {
    console.error("[weekly-digest] users select failed", {
      message: usersErr.message,
    });
    return NextResponse.json({ ok: false, error: "users_select_failed" });
  }

  const eligible = (users ?? []) as ActiveUser[];
  let sent = 0;
  let failed = 0;

  const since7d = Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (const user of eligible) {
    try {
      // Aggregates
      const { count: emailsTriaged } = await supabase
        .from("emails")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .gte("received_at", since7d);

      const { count: draftsSent } = await supabase
        .from("drafts")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("status", "sent")
        .gte("replied_at", new Date(since7d).toISOString());

      const { count: decisionsLogged } = await supabase
        .from("decisions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .gte("created_at", new Date(since7d).toISOString());

      const { count: decisionsAwaitingPostmortem } = await supabase
        .from("decisions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("status", "postmortem_due");

      const { count: reflectionsThisWeek } = await supabase
        .from("daily_reflections")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .gte("created_at", new Date(since7d).toISOString());

      const { data: topDecision } = await supabase
        .from("decisions")
        .select("title")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data: topCold } = await supabase
        .from("contacts")
        .select("display_name")
        .eq("user_id", user.id)
        .gte("cadence_break_days", 28)
        .eq("archived", false)
        .order("cadence_break_days", { ascending: false })
        .limit(1)
        .maybeSingle();

      const source: DigestSource = {
        firstName: firstNameFromEmail(user.email),
        emailsTriaged: emailsTriaged ?? 0,
        draftsSent: draftsSent ?? 0,
        decisionsLogged: decisionsLogged ?? 0,
        decisionsAwaitingPostmortem: decisionsAwaitingPostmortem ?? 0,
        reflectionsThisWeek: reflectionsThisWeek ?? 0,
        topDecisionTitle:
          (topDecision as { title: string } | null)?.title ?? null,
        topCadenceColdContact:
          (topCold as { display_name: string } | null)?.display_name ?? null,
      };

      const { html } = await generateWeeklyDigest(source);

      const { error: sendErr } = await resend.emails.send({
        from: "Wingman <noreply@resend.dev>",
        to: user.email,
        subject: `Your week with Wingman — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
        html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#1a1614;line-height:1.6">${html}<p style="margin-top:32px;font-size:12px;color:#9b9389">— wingman</p></div>`,
      });

      if (sendErr) {
        failed += 1;
        console.error("[weekly-digest] resend failed", {
          user_id: user.id,
          message: sendErr.message,
        });
      } else {
        sent += 1;
      }
    } catch (err) {
      failed += 1;
      console.error("[weekly-digest] per-user failed", {
        user_id: user.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    eligible: eligible.length,
    sent,
    failed,
    elapsedMs: Date.now() - startedAt,
  });
}
