import "server-only";
import { createClerkClient } from "@clerk/backend";

// Module-scoped Clerk client. Warm Lambda invocations reuse the same
// instance — saves ~50-100ms per call vs. constructing per request.
// Cold start still pays the construction cost (once per Lambda).
let _clerk: ReturnType<typeof createClerkClient> | null = null;

function clerk() {
  if (_clerk) return _clerk;
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error("CLERK_SECRET_KEY is not set");
  }
  _clerk = createClerkClient({ secretKey });
  return _clerk;
}

// Fetch the user's Google OAuth access token via Clerk. Token is short-lived
// (~1h) and Clerk handles refresh internally — never cache on our side.
// Throws on Clerk SDK errors (4xx/5xx); caller decides whether to fail
// the action or surface a "reconnect Gmail" CTA to the user.
export async function getGoogleAccessToken(
  clerkUserId: string,
): Promise<string | null> {
  let res;
  try {
    res = await clerk().users.getUserOauthAccessToken(clerkUserId, "google");
  } catch (err) {
    const e = err as {
      message?: string;
      status?: number;
      clerkError?: unknown;
      errors?: unknown;
    };
    console.error("[clerk:getGoogleAccessToken] Clerk SDK threw", {
      clerkUserId,
      message: e.message,
      status: e.status,
      clerkError: e.clerkError,
      errors: e.errors,
    });
    throw err;
  }
  const tokens = res.data ?? [];
  if (tokens.length === 0) return null;
  return tokens[0].token ?? null;
}
