import { NextResponse } from "next/server";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = makeSupabaseServerClient();
  const { count, error } = await supabase
    .from("users")
    .select("*", { count: "exact", head: true });
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, count: count ?? 0 });
}
