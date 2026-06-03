import { NextResponse } from "next/server";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

export async function POST() {
  // POC routes exist to drive the /poc/rls RLS-isolation test page. Local
  // and preview deploys keep them callable; production deploys hard-404 to
  // avoid exposing service_role writes to internet visitors. VERCEL_ENV (not
  // NODE_ENV) is the right check — NODE_ENV='production' is also set on
  // preview builds, which would block PR-preview testing.
  if (process.env.VERCEL_ENV === "production") {
    return NextResponse.json({ error: "not_available" }, { status: 404 });
  }
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
