import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { makeSupabaseServerClient } from "@/lib/supabase/server";

// Two auth paths every Phase 2 server route accepts:
//   1. Clerk session (browser) — resolves via @clerk/nextjs/server auth()
//   2. CRON_SECRET (cron / CLI) — Authorization: Bearer <CRON_SECRET>,
//      with target user passed as user_email in the JSON body
//
// Both paths converge on the same `{ supabaseUserId, clerkUserId }` shape so
// handlers don't branch on auth source. If neither path validates, returns
// `{ error: NextResponse }` and the handler returns it.
//
// Auto-creates the users row on first invocation through the Clerk path.
// Mirrors the Convex getOrCreateInternal pattern but inline so we don't
// need a separate internal mutation.

export type ResolvedUser = {
  supabaseUserId: string;
  clerkUserId: string;
  email: string;
  source: "session" | "cron";
};

export type ResolveResult =
  | { ok: true; user: ResolvedUser }
  | { ok: false; response: NextResponse };

export async function resolveUser(req: NextRequest): Promise<ResolveResult> {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const isCronAuth =
    !!cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (isCronAuth) {
    // Cron / CLI path. user_email comes from body when present; single-user
    // fallback when the users table has exactly one row (parity with the
    // Convex CLI fallback).
    let userEmail: string | undefined;
    try {
      const body = await req.clone().json();
      if (typeof body?.user_email === "string") userEmail = body.user_email;
    } catch {
      // No body or non-JSON — fine, we'll try single-user fallback below.
    }
    const supabase = makeSupabaseServerClient();
    if (userEmail) {
      const { data: row, error } = await supabase
        .from("users")
        .select("id, clerk_user_id, email")
        .eq("email", userEmail)
        .maybeSingle();
      if (error) {
        return {
          ok: false,
          response: NextResponse.json(
            { error: "users_lookup_failed", detail: error.message },
            { status: 500 },
          ),
        };
      }
      if (!row) {
        return {
          ok: false,
          response: NextResponse.json(
            { error: `user_not_found_for_email`, user_email: userEmail },
            { status: 404 },
          ),
        };
      }
      return {
        ok: true,
        user: {
          supabaseUserId: row.id,
          clerkUserId: row.clerk_user_id,
          email: row.email,
          source: "cron",
        },
      };
    }
    // Single-user fallback: only the lone user in the table. Errors out at
    // 0 or 2+ to force an explicit user_email when ambiguous.
    const { data: rows, error } = await supabase
      .from("users")
      .select("id, clerk_user_id, email")
      .limit(2);
    if (error) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "users_list_failed", detail: error.message },
          { status: 500 },
        ),
      };
    }
    if (!rows || rows.length !== 1) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: "cron_fallback_requires_user_email_or_single_user",
            found: rows?.length ?? 0,
          },
          { status: 400 },
        ),
      };
    }
    return {
      ok: true,
      user: {
        supabaseUserId: rows[0].id,
        clerkUserId: rows[0].clerk_user_id,
        email: rows[0].email,
        source: "cron",
      },
    };
  }

  // Clerk-session path. Auto-creates the users row on first hit so every
  // signed-in request has a Supabase row to scope against.
  const { userId: clerkUserId, sessionClaims } = await auth();
  if (!clerkUserId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "not_authenticated" },
        { status: 401 },
      ),
    };
  }
  const clerkEmail =
    (sessionClaims?.email as string | undefined) ?? "";
  const supabase = makeSupabaseServerClient();
  const { data: existing, error: selectErr } = await supabase
    .from("users")
    .select("id, clerk_user_id, email")
    .eq("clerk_user_id", clerkUserId)
    .maybeSingle();
  if (selectErr) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "users_lookup_failed", detail: selectErr.message },
        { status: 500 },
      ),
    };
  }
  if (existing) {
    return {
      ok: true,
      user: {
        supabaseUserId: existing.id,
        clerkUserId: existing.clerk_user_id,
        email: existing.email,
        source: "session",
      },
    };
  }
  const { data: inserted, error: insertErr } = await supabase
    .from("users")
    .insert({
      clerk_user_id: clerkUserId,
      email: clerkEmail,
      paid_tier: false,
    })
    .select("id, clerk_user_id, email")
    .single();
  if (insertErr || !inserted) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "users_create_failed",
          detail: insertErr?.message ?? "no row returned",
        },
        { status: 500 },
      ),
    };
  }
  return {
    ok: true,
    user: {
      supabaseUserId: inserted.id,
      clerkUserId: inserted.clerk_user_id,
      email: inserted.email,
      source: "session",
    },
  };
}
