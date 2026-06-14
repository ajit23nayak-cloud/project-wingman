// Thin Notion API wrappers. Parallel to src/lib/slack/client.ts —
//   (a) one fewer dep,
//   (b) we only use 2 endpoints (search + blocks/children) plus oauth/token,
//   (c) error-handling needs a NotionAuthError typed exception so the cron
//       route can catch + disconnect the integration on revoked tokens.
//
// KEY DIFFERENCE FROM SLACK: Notion uses HTTP status codes as the source of
// truth for errors (401 = unauthorized, 403 = forbidden, 429 = rate limit).
// Slack's quirk is `HTTP 200 + { ok: false, error: "..." }` — Notion does
// the sensible thing and lets HTTP carry the semantics. Error bodies are
// `{ object: "error", status, code, message }`. We branch on res.status
// rather than parsing an `ok` field.
//
// Every request MUST include `Notion-Version: 2022-06-28`. This pins the
// schema (block types, search response shape) — Notion will reject
// unversioned calls and silently change behavior on undated calls without
// the header.

import "server-only";

// Typed sentinel for Notion auth failures. Notion returns HTTP 401 with
// JSON `{ object: "error", code: "unauthorized", ... }` when:
//   - the access token has been revoked from workspace settings
//   - the integration has been deleted
//   - the token is malformed / never valid
//
// All unrecoverable without user action (reconnect Notion). The cron route
// catches NotionAuthError and marks status='disconnected'.
export class NotionAuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly notionCode: string,
  ) {
    super(`notion_auth_failed:${notionCode}`);
    this.name = "NotionAuthError";
  }
}

export type NotionSearchResult = {
  pageId: string;
  title: string;
  lastEditedTime: string; // ISO 8601
  url: string;
  raw: unknown;
};

type NotionErrorBody = {
  object?: string;
  status?: number;
  code?: string;
  message?: string;
};

// Single point where we convert non-2xx responses into either a NotionAuthError
// or a generic notion_api_failed Error. 401 = auth-class; everything else is
// transient or schema-bound (404, 429, 500). Keep the surface narrow so the
// cron's catch can switch on `err instanceof NotionAuthError`.
async function notionFetch(
  path: string,
  accessToken: string,
  init?: { method?: string; body?: unknown },
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const json: NotionErrorBody = await res
      .json()
      .catch(() => ({ code: "unparseable" }));
    if (res.status === 401) {
      throw new NotionAuthError(res.status, json.code ?? "unauthorized");
    }
    throw new Error(
      `notion_api_failed:${path}:${res.status}:${json.code ?? "unknown"}`,
    );
  }
  return (await res.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Title extraction
// ---------------------------------------------------------------------------

type NotionRichText = { plain_text?: string };

type NotionTitleProperty = {
  type?: string;
  title?: NotionRichText[];
};

// Walk a page's `properties` map looking for the property with type==="title"
// (every Notion page has exactly one; the property KEY varies per-database —
// "Name", "Task", "Title", or a Cyrillic equivalent on localized templates).
// Concat all rich_text segments — Notion splits titles at formatting
// boundaries (bold mid-title → 2 segments), so a single .plain_text grab
// only ever yields the first chunk.
function extractTitle(properties: unknown): string {
  if (!properties || typeof properties !== "object") return "";
  const props = properties as Record<string, NotionTitleProperty>;
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop?.type === "title" && Array.isArray(prop.title)) {
      return prop.title.map((t) => t.plain_text ?? "").join("").trim();
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// searchPages: paginate /v1/search, filter on last_edited_time
// ---------------------------------------------------------------------------

type SearchResponse = {
  results?: Array<{
    id?: string;
    last_edited_time?: string;
    url?: string;
    properties?: unknown;
  }>;
  next_cursor?: string | null;
  has_more?: boolean;
};

// Notion's /v1/search returns pages globally ordered by last_edited_time
// DESCENDING (when we ask for it via the sort param). We:
//   1. Walk pages descending,
//   2. Filter client-side: keep results with last_edited_time >= sinceIso,
//   3. Stop paginating once the page's last result drops below sinceIso
//      (any further pages are guaranteed older — they're sorted),
//   4. Cap at `max` regardless to enforce Flag C's 100-page-per-poll limit.
//
// Why client-side filter: Notion's search endpoint has no `since` /
// `timestamp_gte` filter. The `sort` param is the only timestamp affordance.
export async function searchPages(
  accessToken: string,
  sinceIso: string,
  max: number = 100,
): Promise<NotionSearchResult[]> {
  const sinceMs = Date.parse(sinceIso);
  const out: NotionSearchResult[] = [];
  let cursor: string | undefined;

  do {
    const body: Record<string, unknown> = {
      filter: { value: "page", property: "object" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;

    const json = (await notionFetch("/search", accessToken, {
      method: "POST",
      body,
    })) as SearchResponse;

    const results = json.results ?? [];
    let pageHadAnyBelowSince = false;

    for (const page of results) {
      if (
        typeof page.id !== "string" ||
        typeof page.last_edited_time !== "string"
      ) {
        continue;
      }
      const editedMs = Date.parse(page.last_edited_time);
      // NaN = unparseable timestamp → skip the row but DON'T flip the
      // early-exit flag (a single bad row shouldn't truncate the whole feed).
      if (Number.isNaN(editedMs)) continue;
      if (editedMs < sinceMs) {
        pageHadAnyBelowSince = true;
        continue;
      }
      out.push({
        pageId: page.id,
        title: extractTitle(page.properties),
        lastEditedTime: page.last_edited_time,
        url: typeof page.url === "string" ? page.url : "",
        raw: page,
      });
      if (out.length >= max) return out;
    }

    // Results are last_edited_time DESCENDING — once a page contains an
    // entry below sinceIso, every remaining page is guaranteed older. Stop.
    if (pageHadAnyBelowSince) break;

    cursor = json.has_more && json.next_cursor ? json.next_cursor : undefined;
  } while (cursor);

  return out;
}

// ---------------------------------------------------------------------------
// fetchPageBlocks: walk block tree, extract text, slice to 500 chars
// ---------------------------------------------------------------------------

type NotionBlock = {
  id?: string;
  type?: string;
  has_children?: boolean;
  [k: string]: unknown;
};

type BlocksChildrenResponse = {
  results?: NotionBlock[];
  next_cursor?: string | null;
  has_more?: boolean;
};

// Block types that carry user-facing text via a `rich_text` array. Notion
// has ~20 block types total; these 9 cover essentially all page-body text.
// (Code blocks, embeds, equations, child_page references, etc. either carry
// non-prose content or are summaries the founder isn't reading for triage.)
const TEXT_BLOCK_TYPES = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "toggle",
  "quote",
  "callout",
]);

const MAX_RECURSION_DEPTH = 3;
const MAX_BODY_CHARS = 500;

// Pull rich_text[].plain_text from a single block. Notion stores text inside
// the type-named sub-object: `block.paragraph.rich_text`, `block.heading_1.rich_text`,
// etc. We type-assert through `unknown` because the shape is heterogeneous —
// runtime checks below guard the access.
function extractBlockText(block: NotionBlock): string {
  const type = block.type;
  if (!type || !TEXT_BLOCK_TYPES.has(type)) return "";
  const inner = block[type] as { rich_text?: NotionRichText[] } | undefined;
  if (!inner?.rich_text || !Array.isArray(inner.rich_text)) return "";
  return inner.rich_text.map((rt) => rt.plain_text ?? "").join("");
}

// Recursive walker. Depth-capped at 3 to bound runaway block trees (deeply
// nested toggles / callouts can be 20+ levels and we'd spam the API).
// Early-exit once accumulated length crosses MAX_BODY_CHARS — no point
// fetching more child blocks when we're already going to slice. Tracks
// accLen alongside acc.push so the cap check is O(1) instead of an
// O(n) acc.join(" ") per block (was O(n²) over a 500-block page).
async function walkBlocks(
  accessToken: string,
  parentId: string,
  depth: number,
  acc: string[],
  state: { accLen: number },
): Promise<void> {
  if (depth > MAX_RECURSION_DEPTH) return;
  if (state.accLen >= MAX_BODY_CHARS) return;

  let cursor: string | undefined;
  do {
    const query = cursor
      ? `?page_size=100&start_cursor=${encodeURIComponent(cursor)}`
      : "?page_size=100";
    const json = (await notionFetch(
      `/blocks/${parentId}/children${query}`,
      accessToken,
    )) as BlocksChildrenResponse;

    const blocks = json.results ?? [];
    for (const block of blocks) {
      const text = extractBlockText(block);
      if (text) {
        acc.push(text);
        state.accLen += text.length + 1; // +1 for the space we'll join with
      }
      if (state.accLen >= MAX_BODY_CHARS) return;

      if (block.has_children && typeof block.id === "string") {
        await walkBlocks(accessToken, block.id, depth + 1, acc, state);
        if (state.accLen >= MAX_BODY_CHARS) return;
      }
    }

    cursor = json.has_more && json.next_cursor ? json.next_cursor : undefined;
  } while (cursor);
}

// fetchPageBlocks: GET /v1/blocks/{pageId}/children, walk recursively,
// concat all rich_text content with spaces, slice to 500 chars. Returns
// empty string when the page has no text-bearing blocks (image-only pages,
// embeds-only pages, freshly-created blank pages).
export async function fetchPageBlocks(
  accessToken: string,
  pageId: string,
): Promise<string> {
  const acc: string[] = [];
  await walkBlocks(accessToken, pageId, 0, acc, { accLen: 0 });
  return acc.join(" ").slice(0, MAX_BODY_CHARS);
}
