import { NextResponse } from "next/server";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

export async function GET() {
  // See seed-decoy/route.ts for rationale. VERCEL_ENV='production' blocks
  // the route on prod deploys while leaving preview + local working.
  if (process.env.VERCEL_ENV === "production") {
    return NextResponse.json({ error: "not_available" }, { status: 404 });
  }
  const supabase = makeSupabaseServerClient();
  const { count, error } = await supabase
    .from("users")
    .select("*", { count: "exact", head: true });
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, count: count ?? 0 });
}
