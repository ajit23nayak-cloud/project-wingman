"use node";

import { createClerkClient } from "@clerk/backend";

let _clerk: ReturnType<typeof createClerkClient> | null = null;

function clerk() {
  if (_clerk) return _clerk;
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error("CLERK_SECRET_KEY is not set in the Convex environment");
  }
  _clerk = createClerkClient({ secretKey });
  return _clerk;
}

export async function getGoogleAccessToken(
  clerkUserId: string,
): Promise<string | null> {
  // Clerk SDK throws on 4xx with a message that's often just "Bad Request" —
  // unwrap the response body so we can tell apart "token expired",
  // "no oauth connection", "provider not enabled", etc. Re-throw the original
  // so callers' existing catch behavior is unchanged.
  let res;
  try {
    res = await clerk().users.getUserOauthAccessToken(clerkUserId, "google");
  } catch (err) {
    const anyErr = err as {
      message?: string;
      status?: number;
      clerkError?: unknown;
      errors?: unknown;
    };
    console.error("[getGoogleAccessToken] Clerk SDK threw", {
      clerkUserId,
      message: anyErr.message,
      status: anyErr.status,
      clerkError: anyErr.clerkError,
      errors: anyErr.errors,
    });
    throw err;
  }
  const tokens = res.data ?? [];
  if (tokens.length === 0) return null;
  return tokens[0].token ?? null;
}
