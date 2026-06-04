import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import { ADMIN_EMAILS } from "@/lib/admin";

// POST /api/admin/waitlist/mark-invited
//
// Admin-only mutation: flip a waitlist row from 'pending' (or whatever) to
// 'invited' and stamp invited_at. Same admin gate as GET /api/admin/waitlist
// — Clerk session email checked against ADMIN_EMAILS.
//
// Failure modes the client cares about:
//   - not_admin → caller isn't in ADMIN_EMAILS
//   - not_found → id didn't match any waitlist row (PGRST116 from .single())

export const runtime = "nodejs";

type MarkInvitedBody = { id: string };
type MarkInvitedResponse =
  | { ok: true }
  | { ok: false; error: "not_admin" | "not_found" };

export async function POST(req: NextRequest) {
  const { userId, sessionClaims } = await auth();
  if (!userId) {
    return NextResponse.json<MarkInvitedResponse>(
      { ok: false, error: "not_admin" },
      { status: 401 },
    );
  }
  const email = sessionClaims?.email as string | undefined;
  if (!email || !ADMIN_EMAILS.includes(email)) {
    return NextResponse.json<MarkInvitedResponse>(
      { ok: false, error: "not_admin" },
      { status: 403 },
    );
  }

  let body: MarkInvitedBody;
  try {
    body = (await req.json()) as MarkInvitedBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body?.id !== "string" || body.id.length === 0) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const supabase = makeSupabaseServerClient();
  const { error } = await supabase
    .from("waitlist")
    .update({ status: "invited", invited_at: Date.now() })
    .eq("id", body.id)
    .select("id")
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      return NextResponse.json<MarkInvitedResponse>({
        ok: false,
        error: "not_found",
      });
    }
    console.error("[admin/waitlist/mark-invited] update failed", {
      message: error.message,
    });
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }

  return NextResponse.json<MarkInvitedResponse>({ ok: true });
}
