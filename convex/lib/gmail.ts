"use node";

import { google, gmail_v1 } from "googleapis";

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

export function getGmailClient(accessToken: string) {
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

export async function listEmailsLastNDays(
  accessToken: string,
  n = 30,
): Promise<NormalizedEmail[]> {
  const gmail = getGmailClient(accessToken);
  const query = `in:inbox newer_than:${n}d`;

  const messageIds: { id: string; threadId: string }[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 100,
      pageToken,
    });
    const list = res.data.messages ?? [];
    for (const m of list) {
      if (m.id && m.threadId) {
        messageIds.push({ id: m.id, threadId: m.threadId });
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  const results: NormalizedEmail[] = [];
  const batchSize = 10;
  for (let i = 0; i < messageIds.length; i += batchSize) {
    const batch = messageIds.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async ({ id }) => {
        const res = await gmail.users.messages.get({
          userId: "me",
          id,
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
    results.push(...batchResults);
  }

  return results;
}

/**
 * List the user's recent SENT messages and return their plain-text bodies.
 * Used by Day 4 voice sampling: snippets of the user's own writing prime the
 * draftReply prompt. Caps total messages at `max` (default 30) regardless of
 * how many Gmail returns.
 */
export async function listSentMessagesLastNDays(
  accessToken: string,
  n = 30,
  max = 30,
): Promise<{ bodyText: string }[]> {
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

  const out: { bodyText: string }[] = [];
  const batchSize = 10;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (id) => {
        const res = await gmail.users.messages.get({
          userId: "me",
          id,
          format: "full",
        });
        const { bodyText } = extractBodies(res.data.payload);
        return { bodyText };
      }),
    );
    for (const r of batchResults) {
      if (r.bodyText && r.bodyText.trim().length > 0) {
        out.push(r);
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

/**
 * Fetch a single message and return both bodyText and bodyHtml.
 * Public API used by emailBody.fetchEmailBody (detail view + draft prompt).
 */
export async function getMessageBody(
  accessToken: string,
  gmailMessageId: string,
): Promise<{ bodyText: string; bodyHtml: string }> {
  const gmail = getGmailClient(accessToken);
  const res = await gmail.users.messages.get({
    userId: "me",
    id: gmailMessageId,
    format: "full",
  });
  return extractBodies(res.data.payload);
}

/**
 * Fetch just the threading-related headers (Message-ID, References) of an
 * existing message — needed to compose RFC 2822 In-Reply-To / References on
 * a reply we are about to send. Internal helper for sendReply.
 */
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

/**
 * RFC 2047 encode a header value if it contains non-ASCII chars.
 * Plain ASCII passes through unchanged.
 */
function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const b64 = Buffer.from(value, "utf-8").toString("base64");
  return `=?UTF-8?B?${b64}?=`;
}

/**
 * Send a reply on an existing Gmail thread. Looks up the original message's
 * Message-ID / References headers internally so threading works end-to-end:
 * threadId on the send body keeps Gmail's grouping, In-Reply-To + References
 * keep RFC 2822 threading semantics for non-Gmail recipients.
 *
 * `inReplyToMessageId` is Gmail's internal id (the "id" field stored on the
 * emails table), NOT the Message-ID header. The header is fetched here.
 */
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

  // Look up threading headers from the original. If Message-ID is missing
  // (rare), we omit In-Reply-To/References entirely rather than fabricate a
  // header that no other server has ever seen — Gmail-side threading still
  // works via threadId on the send body; non-Gmail recipients lose strict
  // RFC threading, which is the lesser of two evils vs. lying.
  const { messageIdHeader, referencesHeader } =
    await getMessageThreadingHeaders(accessToken, params.inReplyToMessageId);
  const haveMessageId = messageIdHeader && messageIdHeader.length > 0;

  const replySubject = params.subject.toLowerCase().startsWith("re:")
    ? params.subject
    : `Re: ${params.subject}`;

  const headers: string[] = [`To: ${params.toAddress}`];
  // "me" is the Gmail API send-as substitution token, not a valid From: value.
  // Omit the From: header entirely when we don't have a real address — Gmail
  // fills it from the authenticated user.
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
  } else {
    console.warn("[sendReply] original Message-ID header missing", {
      gmailMessageId: params.inReplyToMessageId,
    });
  }
  headers.push(`Content-Type: text/plain; charset="UTF-8"`);
  headers.push(`Content-Transfer-Encoding: 8bit`);
  headers.push(`MIME-Version: 1.0`);

  const raw = headers.join("\r\n") + "\r\n\r\n" + params.replyBody;
  const encoded = Buffer.from(raw, "utf-8").toString("base64url");

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded, threadId: params.threadId },
  });

  return {
    messageId: res.data.id ?? "",
    threadId: res.data.threadId ?? params.threadId,
  };
}
