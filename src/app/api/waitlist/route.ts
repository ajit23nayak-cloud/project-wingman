import { NextRequest, NextResponse } from "next/server";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// POST /api/waitlist
//
// Public, unauthenticated landing-page submission. Mirrors the validation
// rules from convex/waitlist.ts (submitWaitlistApplication) line-for-line:
//   - honeypot must be empty; if not, masquerade as rate_limited so bots
//     can't tell which gate they tripped
//   - sub-1.5s submits are bots, same masquerade
//   - email regex / required-company / required-response / 500-char cap
//
// All form-style failures return HTTP 200 with `{ ok: false, error }` so the
// client surfaces them inline. Only genuine server faults return 500.
//
// Dedup is case-insensitive (email lowercased before insert). DB unique
// constraint on waitlist.email is the source of truth — we catch the 23505
// and report `{ ok: true, duplicate: true }` rather than leak status.

export const runtime = "nodejs";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_FILL_MS = 1500;
const RESPONSE_MAX_CHARS = 500;

type WaitlistBody = {
  email: string;
  company: string;
  overload_response: string;
  honeypot: string;
  formOpenedAt: number;
};

type WaitlistResponse =
  | { ok: true; duplicate: boolean }
  | {
      ok: false;
      error:
        | "rate_limited"
        | "invalid_email"
        | "company_required"
        | "response_required"
        | "response_too_long"
        | "server_error";
    };

export async function POST(req: NextRequest) {
  let body: WaitlistBody;
  try {
    body = (await req.json()) as WaitlistBody;
  } catch {
    // Malformed JSON → masquerade as rate-limit so probes can't fingerprint.
    return NextResponse.json<WaitlistResponse>({
      ok: false,
      error: "rate_limited",
    });
  }

  if (body.honeypot !== "") {
    return NextResponse.json<WaitlistResponse>({
      ok: false,
      error: "rate_limited",
    });
  }
  // typeof guard: omitting formOpenedAt would make the timing check NaN < 1500
  // (false), bypassing the bot gate entirely. Treat a missing/non-number value
  // as a tripped gate.
  if (
    typeof body.formOpenedAt !== "number" ||
    Date.now() - body.formOpenedAt < MIN_FILL_MS
  ) {
    return NextResponse.json<WaitlistResponse>({
      ok: false,
      error: "rate_limited",
    });
  }

  const email = body.email.trim();
  const company = body.company.trim();
  const overloadResponse = body.overload_response.trim();

  if (!EMAIL_REGEX.test(email)) {
    return NextResponse.json<WaitlistResponse>({
      ok: false,
      error: "invalid_email",
    });
  }
  if (company.length === 0) {
    return NextResponse.json<WaitlistResponse>({
      ok: false,
      error: "company_required",
    });
  }
  if (overloadResponse.length === 0) {
    return NextResponse.json<WaitlistResponse>({
      ok: false,
      error: "response_required",
    });
  }
  if (overloadResponse.length > RESPONSE_MAX_CHARS) {
    return NextResponse.json<WaitlistResponse>({
      ok: false,
      error: "response_too_long",
    });
  }

  const normalisedEmail = email.toLowerCase();
  const supabase = makeSupabaseServerClient();
  const { error } = await supabase.from("waitlist").insert({
    email: normalisedEmail,
    company,
    overload_response: overloadResponse,
    status: "pending",
  });

  if (error) {
    // 23505 = unique_violation — already on the waitlist. Report duplicate
    // without leaking whether they were already invited/rejected.
    if (error.code === "23505") {
      return NextResponse.json<WaitlistResponse>({ ok: true, duplicate: true });
    }
    console.error("[waitlist] insert failed", { message: error.message });
    return NextResponse.json<WaitlistResponse>(
      { ok: false, error: "server_error" },
      { status: 500 },
    );
  }

  return NextResponse.json<WaitlistResponse>({ ok: true, duplicate: false });
}
