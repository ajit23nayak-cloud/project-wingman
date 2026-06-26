import { NextRequest, NextResponse } from "next/server";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// POST /api/cron/evening-reflection-banner
//
// pg_cron target (every hour at :05). The banner-showing logic is
// actually client-side (DashboardView reads users.timezone, computes
// local hour, and shows the banner at 21:00-23:00 if no reflection
// for today). This cron is observability-only — it logs the count of
// users currently in the 21:00 window so we can see if the banner is
// being surfaced server-perspective.
//
// Why no server-push: doing a real "set a flag" server-side requires a
// new column + tight coupling between cron timing and client polling.
// Client-side computation against users.timezone is simpler + immediate.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!expected || authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = makeSupabaseServerClient();

  const { data: users, error } = await supabase
    .from("users")
    .select("id, timezone");

  if (error) {
    console.error("[evening-reflection-banner] users select failed", {
      message: error.message,
    });
    return NextResponse.json({ ok: false, error: "users_select_failed" });
  }

  let inWindow = 0;
  const now = new Date();
  for (const user of users ?? []) {
    const tz = (user as { timezone: string | null }).timezone ?? "Asia/Kolkata";
    try {
      const localHour = parseInt(
        new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          hour: "2-digit",
          hour12: false,
        }).format(now),
        10,
      );
      if (localHour >= 21 && localHour < 23) inWindow += 1;
    } catch {
      // Bad tz string — skip
    }
  }

  return NextResponse.json({
    ok: true,
    scanned: users?.length ?? 0,
    inWindow,
  });
}
