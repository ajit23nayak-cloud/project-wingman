import { NextResponse } from "next/server";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

export async function POST() {
  const supabase = makeSupabaseServerClient();
  const fakeClerkId = `poc_decoy_${Date.now()}`;
  const { error } = await supabase.from("users").insert({
    clerk_user_id: fakeClerkId,
    email: `${fakeClerkId}@poc.invalid`,
    paid_tier: false,
  });
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, decoyClerkId: fakeClerkId });
}
