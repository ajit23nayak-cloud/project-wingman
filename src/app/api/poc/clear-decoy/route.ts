import { NextResponse } from "next/server";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

export async function POST() {
  // See seed-decoy/route.ts for rationale. VERCEL_ENV='production' blocks
  // the route on prod deploys while leaving preview + local working.
  if (process.env.VERCEL_ENV === "production") {
    return NextResponse.json({ error: "not_available" }, { status: 404 });
  }
  const supabase = makeSupabaseServerClient();
  const { error, count } = await supabase
    .from("users")
    .delete({ count: "exact" })
    .like("clerk_user_id", "poc_decoy_%");
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, deleted: count ?? 0 });
}
