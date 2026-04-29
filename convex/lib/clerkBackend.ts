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
  const res = await clerk().users.getUserOauthAccessToken(
    clerkUserId,
    "google",
  );
  const tokens = res.data ?? [];
  if (tokens.length === 0) return null;
  return tokens[0].token ?? null;
}
