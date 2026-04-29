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
