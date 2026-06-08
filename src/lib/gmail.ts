import "server-only";
import { google, gmail_v1 } from "googleapis";

// Typed sentinel for Gmail auth failures (401 / invalid_grant / invalid_credentials).
// Routes catch this specifically and call markGmailReauthNeeded — without a
// typed error, the catch would have to inspect every Error subclass to know
// whether the failure is "user needs to reconnect" vs. "transient API hiccup."
export class GmailAuthError extends Error {
  constructor(message = "gmail_auth_failed") {
    super(message);
    this.name = "GmailAuthError";
  }
}

// Detects auth-class errors from googleapis. The thrown shape is observed
// as `{ code?: number, status?: number, message?: string, ... }` (GaxiosError).
// 401 alone could in theory be quota/scoping, but in practice the only 401s
// we see from Gmail are revoked/expired grants; including 'invalid_grant'
// + 'invalid_credentials' covers the typed messages.
export function isGmailAuthError(err: unknown): boolean {
  const e = err as { code?: number; status?: number; message?: string };
  const code = e?.code ?? e?.status;
  if (code === 401) return true;
  if (
    typeof e?.message === "string" &&
    /invalid_grant|invalid_credentials/i.test(e.message)
  ) {
    return true;
  }
  return false;
}

export type EmailIdRef = { messageId: string; threadId: string };

export type NormalizedEmail = {
  messageId: string;
  threadId: string;
  fromAddress: string;
  toAddresses: string[];
  subject: string;
  snippet: string;
  receivedAt: Date;
  bodyText: string;
  bodyHtml: string;
};

export type SentMessage = {
  messageId: string;
  subject: string;
  sentAt: number;
  bodyText: string;
};

// Per-request Gmail client. The googleapis OAuth2 client holds a token —
// can't safely hoist to module scope (would leak across users in a warm
// Lambda). The construction cost is sub-millisecond, so per-request is fine.
function getGmailClient(accessToken: string) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.gmail({ version: "v1", auth });
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

function extractBodies(payload: gmail_v1.Schema$MessagePart | undefined): {
  bodyText: string;
  bodyHtml: string;
} {
  let bodyText = "";
  let bodyHtml = "";
  function walk(part: gmail_v1.Schema$MessagePart | undefined): void {
    if (!part) return;
    const mime = part.mimeType ?? "";
    const data = part.body?.data;
    if (mime === "text/plain" && data && !bodyText) {
      bodyText = decodeBase64Url(data);
    } else if (mime === "text/html" && data && !bodyHtml) {
      bodyHtml = decodeBase64Url(data);
    }
    if (part.parts) {
      for (const child of part.parts) walk(child);
    }
  }
  walk(payload);
  return { bodyText, bodyHtml };
}

function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  if (!headers) return "";
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name?.toLowerCase() === lower) return h.value ?? "";
  }
  return "";
}

function parseAddressList(value: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// List inbox message IDs only — cheap (~700ms for 150 IDs across 2 pages).
// Pairs with getEmailsByIds for the hybrid first-ingest split.
export async function listInboxIdsLastNDays(
  accessToken: string,
  n = 30,
  max?: number,
): Promise<EmailIdRef[]> {
  const gmail = getGmailClient(accessToken);
  const query = `in:inbox newer_than:${n}d`;
  const ids: EmailIdRef[] = [];
  let pageToken: string | undefined;
  do {
    const remaining = max !== undefined ? max - ids.length : 100;
    if (max !== undefined && remaining <= 0) break;
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: max !== undefined ? Math.min(remaining, 100) : 100,
      pageToken,
    });
    const list = res.data.messages ?? [];
    for (const m of list) {
      if (m.id && m.threadId) {
        ids.push({ messageId: m.id, threadId: m.threadId });
        if (max !== undefined && ids.length >= max) break;
      }
    }
    if (max !== undefined && ids.length >= max) break;
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return ids;
}

// Fetch full metadata + snippet for an explicit list of message IDs.
// 10-concurrent batches; ~500ms per batch. Used both by ingestEmails
// (first 30) and by the body-fetch cron route (5 per chunk).
export async function getEmailsByIds(
  accessToken: string,
  ids: EmailIdRef[],
  concurrency = 10,
): Promise<NormalizedEmail[]> {
  const gmail = getGmailClient(accessToken);
  const out: NormalizedEmail[] = [];
  // Defense-in-depth wrap: if a 401/invalid_grant fires mid-batch (rare —
  // tokens are fetched fresh per route invocation, but a long ingest could
  // span an expiry boundary), surface it as a typed GmailAuthError so the
  // route can mark reauth-needed instead of bubbling a raw GaxiosError.
  try {
    for (let i = 0; i < ids.length; i += concurrency) {
      const batch = ids.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(async ({ messageId }) => {
        const res = await gmail.users.messages.get({
          userId: "me",
          id: messageId,
          format: "full",
        });
        const m = res.data;
        const headers = m.payload?.headers;
        const fromAddress = getHeader(headers, "From");
        const toAddresses = parseAddressList(getHeader(headers, "To"));
        const subject = getHeader(headers, "Subject");
        const snippet = m.snippet ?? "";
        const receivedAt = m.internalDate
          ? new Date(parseInt(m.internalDate, 10))
          : new Date();
        const { bodyText, bodyHtml } = extractBodies(m.payload);
        return {
          messageId: m.id ?? "",
          threadId: m.threadId ?? "",
          fromAddress,
          toAddresses,
          subject,
          snippet,
          receivedAt,
          bodyText,
          bodyHtml,
        };
      }),
    );
    out.push(...results);
    }
  } catch (err) {
    if (isGmailAuthError(err)) throw new GmailAuthError();
    throw err;
  }
  return out;
}

// Per-row outcome for the cron body-fetch path. A single Gmail 404 on one
// message shouldn't fail the whole batch — the row gets marked status='failed'
// with a stable error code so the operator can find it in cron_recent_failures.
export type LenientFetchResult =
  | { kind: "ok"; data: NormalizedEmail }
  | { kind: "not_found" }
  | { kind: "error"; detail: string };

export type LenientFetchOutcome = {
  id: EmailIdRef;
  result: LenientFetchResult;
};

// Gmail messages.get over a batch of IDs, returning per-row outcomes instead
// of throwing on the first error. Use from the body-fetch cron route where
// one missing/deleted message shouldn't poison the whole chunk.
export async function getEmailsByIdsLenient(
  accessToken: string,
  ids: EmailIdRef[],
  concurrency = 5,
): Promise<LenientFetchOutcome[]> {
  const gmail = getGmailClient(accessToken);
  const out: LenientFetchOutcome[] = [];
  for (let i = 0; i < ids.length; i += concurrency) {
    const batch = ids.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(
        async (idRef): Promise<LenientFetchOutcome> => {
          try {
            const res = await gmail.users.messages.get({
              userId: "me",
              id: idRef.messageId,
              format: "full",
            });
            const m = res.data;
            const headers = m.payload?.headers;
            const fromAddress = getHeader(headers, "From");
            const toAddresses = parseAddressList(getHeader(headers, "To"));
            const subject = getHeader(headers, "Subject");
            const snippet = m.snippet ?? "";
            const receivedAt = m.internalDate
              ? new Date(parseInt(m.internalDate, 10))
              : new Date();
            const { bodyText, bodyHtml } = extractBodies(m.payload);
            return {
              id: idRef,
              result: {
                kind: "ok",
                data: {
                  messageId: m.id ?? "",
                  threadId: m.threadId ?? "",
                  fromAddress,
                  toAddresses,
                  subject,
                  snippet,
                  receivedAt,
                  bodyText,
                  bodyHtml,
                },
              },
            };
          } catch (err) {
            // Auth errors aren't lenient — if this row's call hit 401 /
            // invalid_grant, the whole user's batch will too (same token).
            // Re-throw as a typed GmailAuthError so the route catches it
            // once and marks the user, instead of returning N "error"
            // outcomes that don't carry the reauth signal.
            if (isGmailAuthError(err)) throw new GmailAuthError();
            const e = err as {
              code?: number;
              status?: number;
              message?: string;
            };
            const code = e.code ?? e.status;
            if (code === 404) {
              return { id: idRef, result: { kind: "not_found" } };
            }
            return {
              id: idRef,
              result: {
                kind: "error",
                detail: e.message ?? String(err),
              },
            };
          }
        },
      ),
    );
    out.push(...results);
  }
  return out;
}

// Convex-era one-shot: list + get in one call. Kept for ingestSentMail
// (handler #2) where we want a single helper for the sent-folder fetch.
export async function listSentMessagesLastNDays(
  accessToken: string,
  n = 30,
  max = 30,
): Promise<SentMessage[]> {
  const gmail = getGmailClient(accessToken);
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const remaining = max - ids.length;
    if (remaining <= 0) break;
    const res = await gmail.users.messages.list({
      userId: "me",
      labelIds: ["SENT"],
      q: `newer_than:${n}d`,
      maxResults: Math.min(remaining, 100),
      pageToken,
    });
    const list = res.data.messages ?? [];
    if (list.length === 0) break;
    for (const m of list) {
      if (m.id) ids.push(m.id);
      if (ids.length >= max) break;
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < max);
  if (ids.length === 0) return [];
  const out: SentMessage[] = [];
  const batchSize = 10;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (id) => {
        const res = await gmail.users.messages.get({
          userId: "me",
          id,
          format: "full",
        });
        const m = res.data;
        const headers = m.payload?.headers;
        const subject = getHeader(headers, "Subject");
        const sentAt = m.internalDate
          ? parseInt(m.internalDate, 10)
          : Date.now();
        const { bodyText } = extractBodies(m.payload);
        return {
          messageId: m.id ?? "",
          subject,
          sentAt,
          bodyText,
        };
      }),
    );
    for (const r of results) {
      if (r.bodyText && r.bodyText.trim().length > 0 && r.messageId) {
        out.push(r);
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

// Fetch just the threading-related headers (Message-ID, References) of an
// existing message — needed to compose RFC 2822 In-Reply-To / References on
// a reply we are about to send. Internal helper for sendReply.
async function getMessageThreadingHeaders(
  accessToken: string,
  gmailMessageId: string,
): Promise<{ messageIdHeader: string; referencesHeader: string }> {
  const gmail = getGmailClient(accessToken);
  const res = await gmail.users.messages.get({
    userId: "me",
    id: gmailMessageId,
    format: "metadata",
    metadataHeaders: ["Message-ID", "References"],
  });
  const headers = res.data.payload?.headers;
  return {
    messageIdHeader: getHeader(headers, "Message-ID"),
    referencesHeader: getHeader(headers, "References"),
  };
}

// RFC 2047 encode a header value if it contains non-ASCII chars. Plain ASCII
// passes through unchanged.
function encodeHeaderValue(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const b64 = Buffer.from(value, "utf-8").toString("base64");
  return `=?UTF-8?B?${b64}?=`;
}

// Assemble the RFC 2822 MIME for a reply without sending. Extracted so the
// dry_run path in /api/drafts/[id]/send can validate end-to-end without
// firing gmail.users.messages.send.
export async function assembleReplyMime(
  accessToken: string,
  params: {
    toAddress: string;
    fromAddress: string;
    subject: string;
    replyBody: string;
    inReplyToMessageId: string;
  },
): Promise<{ raw: string; haveMessageId: boolean }> {
  const { messageIdHeader, referencesHeader } = await getMessageThreadingHeaders(
    accessToken,
    params.inReplyToMessageId,
  );
  const haveMessageId =
    typeof messageIdHeader === "string" && messageIdHeader.length > 0;

  const replySubject = params.subject.toLowerCase().startsWith("re:")
    ? params.subject
    : `Re: ${params.subject}`;

  const headers: string[] = [`To: ${params.toAddress}`];
  if (params.fromAddress && params.fromAddress !== "me") {
    headers.push(`From: ${params.fromAddress}`);
  }
  headers.push(`Subject: ${encodeHeaderValue(replySubject)}`);
  if (haveMessageId) {
    const inReplyTo = messageIdHeader;
    const references =
      referencesHeader && referencesHeader.length > 0
        ? `${referencesHeader} ${inReplyTo}`
        : inReplyTo;
    headers.push(`In-Reply-To: ${inReplyTo}`);
    headers.push(`References: ${references}`);
  }
  headers.push(`Content-Type: text/plain; charset="UTF-8"`);
  headers.push(`Content-Transfer-Encoding: 8bit`);
  headers.push(`MIME-Version: 1.0`);

  const raw = headers.join("\r\n") + "\r\n\r\n" + params.replyBody;
  return { raw, haveMessageId };
}

// Send a reply on an existing Gmail thread. Looks up the original message's
// Message-ID / References headers internally so threading works end-to-end:
// threadId on the send body keeps Gmail's grouping, In-Reply-To + References
// keep RFC 2822 threading semantics for non-Gmail recipients.
//
// `inReplyToMessageId` is Gmail's internal id (the "id" field stored on the
// emails table), NOT the Message-ID header. The header is fetched here.
export async function sendReply(
  accessToken: string,
  params: {
    threadId: string;
    toAddress: string;
    fromAddress: string;
    subject: string;
    replyBody: string;
    inReplyToMessageId: string;
  },
): Promise<{ messageId: string; threadId: string }> {
  const gmail = getGmailClient(accessToken);
  try {
    const { raw, haveMessageId } = await assembleReplyMime(accessToken, params);
    if (!haveMessageId) {
      console.warn("[sendReply] original Message-ID header missing", {
        gmailMessageId: params.inReplyToMessageId,
      });
    }
    const encoded = Buffer.from(raw, "utf-8").toString("base64url");
    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encoded, threadId: params.threadId },
    });
    return {
      messageId: res.data.id ?? "",
      threadId: res.data.threadId ?? params.threadId,
    };
  } catch (err) {
    if (isGmailAuthError(err)) throw new GmailAuthError();
    throw err;
  }
}

export async function getMessageBody(
  accessToken: string,
  gmailMessageId: string,
): Promise<{ bodyText: string; bodyHtml: string }> {
  const gmail = getGmailClient(accessToken);
  try {
    const res = await gmail.users.messages.get({
      userId: "me",
      id: gmailMessageId,
      format: "full",
    });
    return extractBodies(res.data.payload);
  } catch (err) {
    if (isGmailAuthError(err)) throw new GmailAuthError();
    throw err;
  }
}
