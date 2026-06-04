import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { makeSupabaseServerClient } from "@/lib/supabase/server";
import { ADMIN_EMAILS } from "@/lib/admin";

// GET /api/admin/waitlist
//
// Admin-only listing for the waitlist review surface. Gate is the Clerk
// session email checked against ADMIN_EMAILS. The waitlist table itself has
// no SELECT policy under RLS (default-deny), so this route uses the
// service-role client.
//
// Table is small (landing-page signups, expected hundreds), so we pull every
// row and aggregate the status counts client-side rather than firing a
// second COUNT query.

export const runtime = "nodejs";

type WaitlistRow = {
  id: string;
  email: string;
  company: string;
  overload_response: string;
  status: "pending" | "invited" | "rejected";
  created_at: number;
  invited_at: number | null;
};

export async function GET() {
  const { userId, sessionClaims } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const email = sessionClaims?.email as string | undefined;
  if (!email || !ADMIN_EMAILS.includes(email)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const supabase = makeSupabaseServerClient();
  const { data, error } = await supabase
    .from("waitlist")
    .select("id, email, company, overload_response, status, created_at, invited_at")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[admin/waitlist] select failed", { message: error.message });
    return NextResponse.json({ error: "list_failed" }, { status: 500 });
  }

  const applications = (data ?? []) as WaitlistRow[];
  const counts = {
    pending: 0,
    invited: 0,
    rejected: 0,
    total: applications.length,
  };
  for (const row of applications) counts[row.status]++;

  return NextResponse.json({ applications, counts });
}
