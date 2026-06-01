import { NextResponse } from "next/server";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

export async function POST() {
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
