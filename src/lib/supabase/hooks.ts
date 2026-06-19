// Browser-side SWR hooks for the dashboard. All data fetching for the
// dashboard goes through here: useMe loads first (gates the rest), useCounts
// + useEmails query Supabase directly via the Clerk JWT (RLS-scoped), and
// useTriggerIngest fires the server ingest route then invalidates the keys
// above. No Convex.

import { useAuth } from "@clerk/nextjs";
import useSWR, { useSWRConfig } from "swr";
import useSWRInfinite from "swr/infinite";
import { useMemo } from "react";
import { makeSupabaseBrowserClient } from "./client";

// --- client -----------------------------------------------------------------

export function useSupabaseBrowser() {
  const { getToken } = useAuth();
  return useMemo(
    () => makeSupabaseBrowserClient(() => getToken({ template: "supabase" })),
    [getToken],
  );
}

// --- /api/dashboard/me ------------------------------------------------------

// Pinned response shape from /api/dashboard/me, observed empirically against
// src/app/api/dashboard/me/route.ts. The route returns ALL of these keys on
// every successful response — lastIngestedAt, gmailReauthNeededAt, mhStyle,
// and mhAssessmentSkippedAt are nullable (brand-new user before first ingest;
// flag never set; assessment not yet taken/skipped). Other fields are always
// present. When the API contract changes, update this type AND the comment.
// Per CONVENTIONS.md "Pin the observed shape as a code comment."
export type MhStyle = "operational" | "state" | "inquiry";

export type MeData = {
  supabaseUserId: string;
  email: string;
  lastIngestedAt: number | null;
  gmailReauthNeeded: boolean;
  gmailReauthNeededAt: string | null;
  mhStyle: MhStyle | null;
  mhStorageTier: 1 | 2 | 3 | 4;
  mhAssessmentSkippedAt: string | null;
  mhAssessmentSkipCount: number;
};

export function useMe() {
  return useSWR<MeData>(
    "/api/dashboard/me",
    async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`me_fetch_${res.status}`);
      return res.json();
    },
    {
      // After /account → Done → clearReauthFlag → router.push('/dashboard'),
      // SWR was re-rendering cached me-with-flag-true even though DB had
      // cleared (the in-flight mutate completed but the dashboard didn't
      // resubscribe to the new cache value on remount). Forcing
      // revalidateOnMount guarantees any server-side state change (flag
      // toggles, last_ingested_at bumps, anything route handlers write)
      // reflects on the next dashboard visit. Cost: one extra GET per
      // mount, fine for a small JSON endpoint.
      revalidateOnMount: true,
    },
  );
}

// --- drafts: generate / patch / delete / send -------------------------------

// Each hook invalidates the matching useEmail(emailId) key so the detail
// page re-renders with the updated draft state. We don't return SWR shape
// here because these are imperative actions, not subscriptions.

export function useGenerateDraft() {
  const { mutate } = useSWRConfig();
  const { data: me } = useMe();
  return async (
    emailId: string,
  ): Promise<{ ok: boolean; body?: string; error?: string }> => {
    try {
      const res = await fetch("/api/drafts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email_id: emailId }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        if (me) {
          await mutate(["email", emailId, me.supabaseUserId]);
        }
        return { ok: true, body: data.body };
      }
      return { ok: false, error: data.error ?? `generate_${res.status}` };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "network_error",
      };
    }
  };
}

export function useUpdateDraft() {
  const { mutate } = useSWRConfig();
  const { data: me } = useMe();
  return async (
    draftId: string,
    body: string,
    emailId: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(`/api/drafts/${draftId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        if (me) await mutate(["email", emailId, me.supabaseUserId]);
        return { ok: true };
      }
      return { ok: false, error: data.error ?? `patch_${res.status}` };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "network_error",
      };
    }
  };
}

export function useDeleteDraft() {
  const { mutate } = useSWRConfig();
  const { data: me } = useMe();
  return async (
    draftId: string,
    emailId: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(`/api/drafts/${draftId}`, { method: "DELETE" });
      const data = await res.json();
      if (res.ok && data.ok) {
        if (me) await mutate(["email", emailId, me.supabaseUserId]);
        return { ok: true };
      }
      return { ok: false, error: data.error ?? `delete_${res.status}` };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "network_error",
      };
    }
  };
}

export function useSendDraft() {
  const { mutate } = useSWRConfig();
  const { data: me } = useMe();
  return async (
    draftId: string,
    emailId: string,
  ): Promise<{ ok: boolean; error?: string; messageId?: string }> => {
    try {
      const res = await fetch(`/api/drafts/${draftId}/send`, {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        if (me) {
          await mutate(["email", emailId, me.supabaseUserId]);
          // Also nudge the dashboard email list so the ✓ chip updates.
          await mutate(
            (key) => Array.isArray(key) && key[0] === "emails",
          );
        }
        return { ok: true, messageId: data.messageId };
      }
      return { ok: false, error: data.error ?? `send_${res.status}` };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "network_error",
      };
    }
  };
}

// --- clear-reauth-flag ------------------------------------------------------

// POSTs /api/dashboard/clear-reauth-flag, then revalidates useMe so the
// dashboard banner disappears immediately. Called from the /account page's
// Done button after the user reconnects Gmail.
export function useClearReauthFlag() {
  const { mutate } = useSWRConfig();
  return async (): Promise<{ ok: boolean }> => {
    try {
      const res = await fetch("/api/dashboard/clear-reauth-flag", {
        method: "POST",
      });
      if (!res.ok) return { ok: false };
      mutate("/api/dashboard/me");
      return { ok: true };
    } catch {
      return { ok: false };
    }
  };
}

// --- email_counts RPC -------------------------------------------------------

export type Counts = {
  total: number;
  urgent: number;
  important: number;
  fyi: number;
  archive: number;
  failed: number;
  pending: number;
};

export function useCounts() {
  const supabase = useSupabaseBrowser();
  const { data: me } = useMe();
  return useSWR<Counts>(
    me ? ["email_counts", me.supabaseUserId] : null,
    async () => {
      const { data, error } = await supabase.rpc("email_counts");
      if (error) throw new Error(error.message);
      // RPC always returns 1 row for a logged-in user; null/empty only happens
      // on RLS-deny edges (e.g., useMe raced ahead of users-row insert).
      // Throw a clean error rather than crash on `.[0]` of null.
      const row = (data as Counts[] | null)?.[0];
      if (!row) throw new Error("email_counts_empty");
      return row;
    },
  );
}

// --- Slack workspace --------------------------------------------------------

// Pinned shape from supabase.from('slack_workspaces').select(...) — RLS-scoped to the
// current user. Returns an array; v0 supports one workspace per user, so we read row[0]
// or null. Future v1 multi-workspace returns the full array.
export type SlackWorkspaceRow = {
  id: string;
  team_id: string;
  team_name: string | null;
  bot_user_id: string | null;
  status: "active" | "disconnected";
  connected_at: string;
  disconnected_at: string | null;
  last_polled_at: string | null;
};

export function useSlackWorkspace() {
  const supabase = useSupabaseBrowser();
  const { data: me } = useMe();
  return useSWR<SlackWorkspaceRow | null>(
    me ? ["slack_workspace", me.supabaseUserId] : null,
    async () => {
      const { data, error } = await supabase
        .from("slack_workspaces")
        .select(
          "id, team_id, team_name, bot_user_id, status, connected_at, disconnected_at, last_polled_at",
        )
        .order("connected_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as SlackWorkspaceRow[];
      return rows[0] ?? null;
    },
    { revalidateOnMount: true },
  );
}

// --- Slack messages (classifier list) ---------------------------------------

// Pinned shape from supabase.from('slack_messages').select(...) — RLS-scoped
// by the existing slack_messages_select_own policy (migration 0014 line ~199).
// classification is non-null in the result set because we filter
// status='processed' AND classification IS NOT NULL.
export type SlackMessageRow = {
  id: string;
  workspace_id: string;
  channel_id: string;
  sender_name: string | null;
  sender_id: string;
  text: string;
  // Reuses the EmailRow classification union; defined further down in this
  // file but TS hoists types so the forward reference is safe.
  classification: NonNullable<EmailRow["classification"]>;
  classification_reason: string | null;
  received_at: number; // epoch ms
};

export function useSlackMessages(filter: FilterValue) {
  const supabase = useSupabaseBrowser();
  const { data: me } = useMe();
  return useSWR<SlackMessageRow[]>(
    me ? ["slack_messages", filter, me.supabaseUserId] : null,
    async () => {
      let query = supabase
        .from("slack_messages")
        .select(
          "id, workspace_id, channel_id, sender_name, sender_id, text, classification, classification_reason, received_at",
        )
        .eq("status", "processed")
        .not("classification", "is", null)
        .order("received_at", { ascending: false })
        .limit(20);
      if (filter !== "all") {
        query = query.eq("classification", filter);
      }
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return (data ?? []) as SlackMessageRow[];
    },
  );
}

// --- Notion integration -----------------------------------------------------

// Pinned shape from supabase.from('notion_integrations').select(...) — RLS-scoped
// to the current user via the standard own-rows policy on notion_integrations.
// Returns an array; v0 supports one workspace per user, so we read row[0] or
// null. Future v1 multi-workspace returns the full array. Mirrors the
// useSlackWorkspace shape — same Connect/Disconnected/Reconnect surface.
export type NotionIntegrationRow = {
  id: string;
  workspace_id: string;
  workspace_name: string | null;
  workspace_icon: string | null;
  bot_id: string | null;
  status: "active" | "disconnected";
  connected_at: string;
  disconnected_at: string | null;
  last_polled_at: string | null;
};

export function useNotionIntegration() {
  const supabase = useSupabaseBrowser();
  const { data: me } = useMe();
  return useSWR<NotionIntegrationRow | null>(
    me ? ["notion_integration", me.supabaseUserId] : null,
    async () => {
      const { data, error } = await supabase
        .from("notion_integrations")
        .select(
          "id, workspace_id, workspace_name, workspace_icon, bot_id, status, connected_at, disconnected_at, last_polled_at",
        )
        .order("connected_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as NotionIntegrationRow[];
      return rows[0] ?? null;
    },
    { revalidateOnMount: true },
  );
}

// --- Notion pages (classifier list) -----------------------------------------

// Pinned shape from supabase.from('notion_pages').select(...) — RLS-scoped by
// the notion_pages_select_own policy. classification is non-null in the result
// set because we filter status='processed' AND classification IS NOT NULL.
// received_at is epoch ms (matches slack_messages.received_at and
// emails.received_at — uniform sort key across all three sources).
export type NotionPageRow = {
  id: string;
  integration_id: string;
  page_id: string;
  title: string;
  snippet: string;
  url: string | null;
  classification: NonNullable<EmailRow["classification"]>;
  classification_reason: string | null;
  received_at: number;
};

// useNotionPages accepts `FilterValue | null`. Pass `null` when no Notion
// integration exists so the SWR key is null and the query never fires —
// avoids the "reactive query amplification" anti-pattern where the hook
// would issue a Supabase query every dashboard mount + every filter change
// even for users without Notion (RLS returns 0 rows, but it's wasted bandwidth).
export function useNotionPages(filter: FilterValue | null) {
  const supabase = useSupabaseBrowser();
  const { data: me } = useMe();
  return useSWR<NotionPageRow[]>(
    me && filter ? ["notion_pages", filter, me.supabaseUserId] : null,
    async () => {
      let query = supabase
        .from("notion_pages")
        .select(
          "id, integration_id, page_id, title, snippet, url, classification, classification_reason, received_at",
        )
        .eq("status", "processed")
        .not("classification", "is", null)
        .order("received_at", { ascending: false })
        .limit(20);
      // filter is non-null inside the fetcher (gated above), but TS doesn't
      // narrow through the key fn. Defensive check + narrow.
      if (filter && filter !== "all") {
        query = query.eq("classification", filter);
      }
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return (data ?? []) as NotionPageRow[];
    },
  );
}

// --- Notion OKR pages (Phase 4) --------------------------------------------

// Pinned shape from supabase.from('notion_pages').select(...) where
// is_okr_page=true. okr_structured is the jsonb shape produced by
// src/lib/prompts/okrExtract.ts — { quarter?, objectives: [{ text,
// key_results: [...] }] }. Can be null when detect=true but extract
// failed/returned empty (logged warning, dashboard shows "detected
// but not parsed" state).
export type OKRKeyResult = {
  text: string;
  progress?: string | null;
  confidence?: "green" | "yellow" | "red" | null;
};

export type OKRObjective = {
  text: string;
  key_results: OKRKeyResult[];
};

export type OKRStructured = {
  quarter?: string | null;
  objectives: OKRObjective[];
};

export type OKRPageRow = {
  id: string;
  page_id: string;
  title: string;
  url: string | null;
  okr_structured: OKRStructured | null;
  last_edited_at: string;
  okr_extracted_at: string | null;
};

// Accepts `enabled: boolean | null` — pass null when no Notion integration
// exists so the SWR key stays null and no query fires. Mirrors
// useCalendarToday / useNotionPages gating per the C1#3 anti-amplification
// pattern. The `enabled` flag is computed in DashboardView from
// useNotionIntegration().
export function useOKRs(enabled: boolean | null) {
  const supabase = useSupabaseBrowser();
  const { data: me } = useMe();
  return useSWR<OKRPageRow[]>(
    me && enabled ? ["okrs", me.supabaseUserId] : null,
    async () => {
      const { data, error } = await supabase
        .from("notion_pages")
        .select(
          "id, page_id, title, url, okr_structured, last_edited_at, okr_extracted_at",
        )
        .eq("is_okr_page", true)
        .eq("archived_stale", false)
        .order("last_edited_at", { ascending: false })
        .limit(20);
      if (error) throw new Error(error.message);
      return (data ?? []) as OKRPageRow[];
    },
    { revalidateOnMount: true },
  );
}

// --- calendar credentials (status only) -------------------------------------

// Pinned shape from GET /api/dashboard/calendar-status — server route projects
// from calendar_credentials WITHOUT access_token / refresh_token, so tokens
// never reach the browser. The table has RLS-with-zero-policies (browser is
// denied at the table level); this route is the only browser-visible status
// path. Returns null when the user has never connected.
export type CalendarCredentialsRow = {
  status: "active" | "disconnected";
  scope: string;
  token_expires_at: string;
  connected_at: string;
  disconnected_at: string | null;
  updated_at: string;
};

export function useCalendarCredentials() {
  const { data: me } = useMe();
  // User-scope the SWR key so a Clerk session swap (user A signs out,
  // user B signs in same tab) doesn't return user A's cached credential
  // status to user B until next revalidation. Mirrors useCounts /
  // useSlackWorkspace / useNotionIntegration pattern.
  return useSWR<CalendarCredentialsRow | null>(
    me ? ["calendar_credentials", me.supabaseUserId] : null,
    async () => {
      const res = await fetch("/api/dashboard/calendar-status");
      if (!res.ok) throw new Error(`calendar_status_${res.status}`);
      return res.json();
    },
    { revalidateOnMount: true },
  );
}

// --- calendar events (today + tomorrow) -------------------------------------

// Pinned shape from supabase.from('calendar_events').select(...) — RLS-scoped
// to the current user via the calendar_events own-rows policy (migration 0019).
// Cancelled events filtered at query time (event_status='confirmed'). attendees
// is the raw Google jsonb shape — each entry has email + responseStatus +
// optional displayName/self/organizer. attendee_count and external_attendee_count
// are server-precomputed counts (no need to .length the array in the UI).
export type CalendarEventRow = {
  id: string;
  google_event_id: string;
  title: string;
  start_at: string;
  end_at: string;
  all_day: boolean;
  location: string | null;
  conference_link: string | null;
  conference_type: string | null;
  organizer_email: string | null;
  organizer_self: boolean;
  attendees: Array<{
    email?: string;
    self?: boolean;
    organizer?: boolean;
    responseStatus?: string;
    displayName?: string;
  }> | null;
  attendee_count: number | null;
  external_attendee_count: number | null;
  user_response_status:
    | "accepted"
    | "tentative"
    | "declined"
    | "needsAction"
    | null;
  event_status: "confirmed" | "tentative" | "cancelled";
  prep_priority: "high" | "medium" | "low" | "none" | null;
  prep_notes: string | null;
};

// Accepts `boolean | null` enabled flag. Pass `null` (or `false`) when no
// calendar credentials exist so the SWR key is null and the query never fires
// — mirrors the useNotionPages C1#3 pattern of gating expensive RLS-scoped
// queries on integration-presence to avoid the reactive-query-amplification
// anti-pattern documented in MEMORY.md.
export function useCalendarToday(enabled: boolean | null) {
  const supabase = useSupabaseBrowser();
  const { data: me } = useMe();
  return useSWR<{ today: CalendarEventRow[]; tomorrow: CalendarEventRow[] }>(
    me && enabled ? ["calendar_today", me.supabaseUserId] : null,
    async () => {
      const now = new Date();
      const startOfToday = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
      );
      const startOfTomorrow = new Date(
        startOfToday.getTime() + 24 * 60 * 60 * 1000,
      );
      const startOfDayAfter = new Date(
        startOfTomorrow.getTime() + 24 * 60 * 60 * 1000,
      );

      const { data, error } = await supabase
        .from("calendar_events")
        .select(
          "id, google_event_id, title, start_at, end_at, all_day, location, conference_link, conference_type, organizer_email, organizer_self, attendees, attendee_count, external_attendee_count, user_response_status, event_status, prep_priority, prep_notes",
        )
        .eq("event_status", "confirmed")
        .gte("start_at", startOfToday.toISOString())
        .lt("start_at", startOfDayAfter.toISOString())
        .order("start_at", { ascending: true });

      if (error) throw new Error(error.message);
      const rows = (data ?? []) as CalendarEventRow[];
      const today: CalendarEventRow[] = [];
      const tomorrow: CalendarEventRow[] = [];
      for (const ev of rows) {
        const startMs = new Date(ev.start_at).getTime();
        if (startMs < startOfTomorrow.getTime()) today.push(ev);
        else tomorrow.push(ev);
      }
      return { today, tomorrow };
    },
    // Drop refreshInterval — 5-min polling on a tab open all day is 12
    // wasted queries/hour even when the user isn't looking, which is
    // exactly the reactive-query-amplification anti-pattern from
    // MEMORY.md. Rely on SWR's default revalidateOnFocus (re-fetch when
    // the tab regains focus) — that's the right cadence for a calendar
    // (events change a few times per day, not continuously).
    { revalidateOnMount: true },
  );
}

// DELETE /api/dashboard/calendar-status then invalidates both the credential
// status key AND the calendar_today event-list keys so the dashboard flips
// to the disconnected state without a manual refresh.
export function useDisconnectCalendar() {
  const { mutate } = useSWRConfig();
  return async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch("/api/dashboard/calendar-status", {
        method: "DELETE",
      });
      if (!res.ok) return { ok: false, error: `disconnect_${res.status}` };
      // Invalidate both calendar keys. useCalendarCredentials is now
      // user-scoped ([calendar_credentials, supabaseUserId]) so we
      // match by prefix; useCalendarToday is the same shape.
      await mutate(
        (key) => Array.isArray(key) && key[0] === "calendar_credentials",
      );
      await mutate(
        (key) => Array.isArray(key) && key[0] === "calendar_today",
      );
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "network_error",
      };
    }
  };
}

// --- single email + draft ---------------------------------------------------

// Pinned response shape from `supabase.from('emails').select('*, drafts(*)')
// .eq('id', id).single()`, observed empirically. The `drafts` field is a
// SINGLE OBJECT OR NULL because drafts.email_id has a UNIQUE constraint —
// PostgREST treats it as one-to-one. Per CONVENTIONS.md "Pin the observed
// shape as a code comment" (the canonical case study for this rule).
//
// Fields included match what /email/[id] EmailDetailView actually reads —
// extending the SELECT later requires updating both the query string in
// useEmail() AND this type.
export type EmailDetail = {
  id: string;
  gmail_message_id: string;
  thread_id: string;
  from_address: string;
  to_addresses: string[];
  subject: string;
  snippet: string;
  received_at: number;
  classification: "urgent" | "important" | "fyi" | "archive" | null;
  classification_reason: string | null;
  classification_error: string | null;
  status: "pending" | "processed" | "failed";
  drafts: DraftRow | null;
};

export type DraftRow = {
  id: string;
  body: string;
  generated_at: number;
  edited_at: number | null;
  status: "unsent" | "sent";
  reply_message_id: string | null;
  replied_at: number | null;
  segment_used: string | null;
};

export function useEmail(emailId: string) {
  const supabase = useSupabaseBrowser();
  const { data: me } = useMe();
  return useSWR<EmailDetail | null>(
    me ? ["email", emailId, me.supabaseUserId] : null,
    async () => {
      const { data, error } = await supabase
        .from("emails")
        .select(
          "id, gmail_message_id, thread_id, from_address, to_addresses, subject, snippet, received_at, classification, classification_reason, classification_error, status, drafts(id, body, generated_at, edited_at, status, reply_message_id, replied_at, segment_used)",
        )
        .eq("id", emailId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as unknown as EmailDetail) ?? null;
    },
  );
}

// Pinned shape from /api/emails/[id]/body: always returns { bodyText: string,
// error?: string }. bodyText is non-null even on error (falls back to the
// snippet). error code is one of: token_fetch_failed, no_google_token,
// gmail_auth_failed, gmail_fetch_failed, email_not_found, lookup_failed.
export type EmailBodyResponse = {
  bodyText: string;
  error?: string;
};

export function useEmailBody(emailId: string) {
  const { data: me } = useMe();
  return useSWR<EmailBodyResponse>(
    me ? `/api/emails/${emailId}/body` : null,
    async (url: string) => {
      const res = await fetch(url);
      if (!res.ok && res.status !== 404) {
        // 404 returns a usable body in the JSON; only other failures throw.
        const txt = await res.text();
        throw new Error(`body_fetch_${res.status}: ${txt.slice(0, 100)}`);
      }
      return res.json();
    },
  );
}

// --- daily ritual prefill + streak ------------------------------------------

// Pinned shapes from /api/mh/ritual/today and /api/mh/streak (CONVENTIONS.md
// rule 2). Session rows are nullable because either morning or evening (or
// both) may not have been done yet today.
export type RitualSession = {
  id: string;
  type: "morning_ritual" | "evening_ritual";
  framework_used: "operational" | "state" | "inquiry" | "mixed";
  numeric_data: Record<string, unknown> | null;
  text_data: Record<string, unknown> | null;
  created_at: string;
};

export type TodayRitualResponse = {
  morning: RitualSession | null;
  evening: RitualSession | null;
};

export function useTodayRitual() {
  const { data: me } = useMe();
  return useSWR<TodayRitualResponse>(
    me ? "/api/mh/ritual/today" : null,
    async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`today_${res.status}`);
      return res.json();
    },
    { revalidateOnMount: true },
  );
}

export function useStreak() {
  const { data: me } = useMe();
  return useSWR<{ streakDays: number }>(
    me ? "/api/mh/streak" : null,
    async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`streak_${res.status}`);
      return res.json();
    },
    { revalidateOnMount: true },
  );
}

// --- storage tier preview + change ------------------------------------------

export type StorageTierPreview = {
  currentTier: 1 | 2 | 3 | 4;
  newTier: 1 | 2 | 3 | 4;
  isDowngrade: boolean;
  textToBeNulled: number;
  numericToBeNulled: number;
  correlationsToBeDeleted: number;
};

// One-shot preview fetch — call inside the confirm modal when it opens.
// Not an SWR subscription (the modal is short-lived). Returns null on auth
// failure or invalid newTier; caller treats null as "skip the modal."
export function useStorageTierPreview() {
  return async (newTier: 1 | 2 | 3 | 4): Promise<StorageTierPreview | null> => {
    try {
      const res = await fetch(`/api/me/storage_tier/preview?newTier=${newTier}`);
      if (!res.ok) return null;
      return (await res.json()) as StorageTierPreview;
    } catch {
      return null;
    }
  };
}

export function useUpdateStorageTier() {
  const { mutate } = useSWRConfig();
  return async (
    newTier: 1 | 2 | 3 | 4,
  ): Promise<{
    ok: boolean;
    error?: string;
    cleanup?: {
      textNulled: number;
      numericNulled: number;
      correlationsDeleted: number;
    };
  }> => {
    try {
      const res = await fetch("/api/me/storage_tier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newTier }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        // Invalidate dependent caches per Tab 2 Flag D lock.
        await mutate("/api/dashboard/me");
        await mutate(
          (key) =>
            Array.isArray(key) &&
            (key[0] === "recent_rituals" || key[0] === "email_counts"),
        );
        // Today's ritual prefill may now be stale if text_data was nulled.
        await mutate("/api/mh/ritual/today");
        return {
          ok: true,
          cleanup: data.cleanupApplied,
        };
      }
      return { ok: false, error: data.error ?? `tier_${res.status}` };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "network_error",
      };
    }
  };
}

// --- on-demand "Help me think" ----------------------------------------------

// Persist a complete on-demand session (one of 4 routes). For chat sessions,
// the client accumulates transcript locally and posts the final transcript
// here at session-end. For deterministic routes (OPA / Katie / energy), the
// client posts after form submit.
export function useSaveOnDemand() {
  return async (
    route: "decision" | "inquiry" | "drained" | "other",
    raw: Record<string, unknown>,
  ): Promise<{ ok: boolean; sessionId?: string; error?: string }> => {
    try {
      const res = await fetch("/api/mh/on_demand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route, raw }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        return { ok: true, sessionId: data.sessionId };
      }
      return { ok: false, error: data.error ?? `save_${res.status}` };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "network_error",
      };
    }
  };
}

// One LLM turn for chat fallback. Client sends transcript ending in user
// message; server returns assistant response. Stateless per-turn — no DB
// write here (final transcript persisted via useSaveOnDemand at session-end).
export type ChatMessage = { role: "user" | "assistant"; content: string };

export function useChatTurn() {
  return async (
    transcript: ChatMessage[],
  ): Promise<{
    ok: boolean;
    assistantMessage?: string;
    turnsUsed?: number;
    error?: string;
  }> => {
    try {
      const res = await fetch("/api/mh/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        return {
          ok: true,
          assistantMessage: data.assistantMessage,
          turnsUsed: data.turnsUsed,
        };
      }
      return { ok: false, error: data.error ?? `chat_${res.status}` };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "network_error",
      };
    }
  };
}

// --- recent rituals (for missed-ritual nudge trigger) -----------------------

// Returns the timestamp of the most recent ritual entry for this user, or
// null if none. Used by useNudges to compute days-since-last-ritual.
export function useRecentRituals() {
  const supabase = useSupabaseBrowser();
  const { data: me } = useMe();
  return useSWR<{ lastRitualAt: string | null }>(
    me ? ["recent_rituals", me.supabaseUserId] : null,
    async () => {
      const { data, error } = await supabase
        .from("mh_sessions")
        .select("created_at")
        .in("type", ["morning_ritual", "evening_ritual"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return { lastRitualAt: data?.created_at ?? null };
    },
    { revalidateOnMount: true },
  );
}

// --- safety escalation count (Commit F proactive nudge) --------------------

// Count of safety escalations for the current user in the last 7 days.
// Drives the dashboard proactive nudge banner when count >= 3 — per Tab 2
// 01:05 UTC + Ajit all-8 lock. RLS-scoped browser-direct query.
export function useEscalationCount7d() {
  const supabase = useSupabaseBrowser();
  const { data: me } = useMe();
  return useSWR<number>(
    me ? ["escalation_count_7d", me.supabaseUserId] : null,
    async () => {
      const sevenDaysAgo = new Date(
        Date.now() - 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const { count, error } = await supabase
        .from("mh_escalations")
        .select("id", { count: "exact", head: true })
        .gte("created_at", sevenDaysAgo);
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
    { revalidateOnMount: true },
  );
}

// --- contextual nudges ------------------------------------------------------

import {
  computeTriggers,
  copyFor,
  patternsFor,
  MAX_OBSERVATIONS_PER_LOAD,
  type ActiveTrigger,
  type WidgetContent,
  type ObservationContent,
} from "@/lib/mh/nudges";

export type ResolvedNudges = {
  widget: WidgetContent | null;
  // Trigger id whose widget is currently rendered. Returned alongside so the
  // dashboard can mark-seen via markNudgeWidgetSeen() in a useEffect AFTER
  // render — never at compute time inside this hook.
  widgetTrigger: string | null;
  observations: ObservationContent[];
  isLoading: boolean;
};

function daysSinceFromTimestamp(ts: string | null): number | null {
  if (!ts) return null;
  const last = new Date(ts);
  last.setUTCHours(0, 0, 0, 0);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const diffMs = today.getTime() - last.getTime();
  return Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
}

// localStorage frequency cap. Namespaced by clerkUserId per Tab 2 22:50 UTC
// flag C — multi-account browsers don't collide. v0 mechanism; v1 moves
// to server-side mh_nudges table.
function widgetSeenToday(clerkUserId: string, triggerId: string): boolean {
  if (typeof window === "undefined") return false;
  const key = `wingman:nudges:widgetSeen:${clerkUserId}:${triggerId}`;
  const stored = window.localStorage.getItem(key);
  const today = new Date().toISOString().slice(0, 10);
  return stored === today;
}

function markWidgetSeen(clerkUserId: string, triggerId: string): void {
  if (typeof window === "undefined") return;
  const key = `wingman:nudges:widgetSeen:${clerkUserId}:${triggerId}`;
  const today = new Date().toISOString().slice(0, 10);
  window.localStorage.setItem(key, today);
}

// Exposed so DashboardView can mark-seen AFTER the widget actually renders
// in DOM. Per Tab 2 01:35 batch instruction: don't write the seen flag from
// inside useNudges (compute time) because there's no guarantee the consumer
// will render the widget. Marking at render-time eliminates the speculative-
// seen-write bug class — if widget never reaches DOM, flag stays unset, next
// visit retries.
export function markNudgeWidgetSeen(
  supabaseUserId: string,
  triggerId: string,
): void {
  markWidgetSeen(supabaseUserId, triggerId);
}

// Composes useMe + useCounts + useRecentRituals → array of active triggers
// → style-routed nudges → frequency-capped output. Widget shows the
// highest-priority trigger that hasn't been seen today; observations stack
// up to MAX_OBSERVATIONS_PER_LOAD.
//
// "Highest priority" v0 ordering: missed_ritual > urgent_overflow. Missed
// ritual is a deeper signal (engagement) than inbox load (operational).
// When trigger count grows, formalize via a priority field on Trigger.
const TRIGGER_PRIORITY: Record<string, number> = {
  missed_ritual: 0,
  urgent_overflow: 1,
};

export function useNudges(): ResolvedNudges {
  const { data: me } = useMe();
  const { data: counts } = useCounts();
  const recent = useRecentRituals();

  const isLoading =
    me === undefined || counts === undefined || recent.data === undefined;

  if (isLoading || !me) {
    return { widget: null, widgetTrigger: null, observations: [], isLoading: true };
  }

  const daysSince = daysSinceFromTimestamp(recent.data?.lastRitualAt ?? null);
  const triggers = computeTriggers({
    urgentCount: counts?.urgent ?? 0,
    daysSinceLastRitual: daysSince,
  });

  // Apply priority sort so widget picks the highest-priority trigger and
  // observations render in a stable order across loads.
  const sorted = [...triggers].sort((a, b) => {
    const ap = TRIGGER_PRIORITY[a.id] ?? 99;
    const bp = TRIGGER_PRIORITY[b.id] ?? 99;
    return ap - bp;
  });

  const assessmentSkipped = me.mhAssessmentSkipCount > 0;

  let widget: WidgetContent | null = null;
  let widgetTrigger: string | null = null;
  const observations: ObservationContent[] = [];

  for (const trig of sorted) {
    const patterns = patternsFor(trig.id, me.mhStyle, assessmentSkipped);
    if (patterns.length === 0) continue;
    const copy = copyFor(trig as ActiveTrigger, me.mhStyle);
    if (patterns.includes("widget") && !widget && copy.widget) {
      // Frequency cap: skip widget if user already saw this trigger's widget
      // today. Read here at compute time so we don't show a widget the user
      // has dismissed; the WRITE side of the seen flag has moved to
      // DashboardView's render-time useEffect (markNudgeWidgetSeen).
      if (!widgetSeenToday(me.supabaseUserId, trig.id)) {
        widget = copy.widget;
        widgetTrigger = trig.id;
      }
    }
    if (
      patterns.includes("observation") &&
      copy.observation &&
      observations.length < MAX_OBSERVATIONS_PER_LOAD
    ) {
      observations.push(copy.observation);
    }
  }

  return { widget, widgetTrigger, observations, isLoading: false };
}

// --- drafts count -----------------------------------------------------------

// Returns the total drafts count for the current user (RLS-scoped). Used by
// the dashboard's first-run "Get started" banner — banner hides as soon as
// the user has generated at least one draft. Cheap: PostgREST `count: exact,
// head: true` returns the number without the rows.
export function useDraftCount() {
  const supabase = useSupabaseBrowser();
  const { data: me } = useMe();
  return useSWR<number>(
    me ? ["drafts_count", me.supabaseUserId] : null,
    async () => {
      const { count, error } = await supabase
        .from("drafts")
        .select("id", { count: "exact", head: true });
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
  );
}

// --- emails (paginated) -----------------------------------------------------

export type EmailRow = {
  id: string;
  gmail_message_id: string;
  from_address: string;
  to_addresses: string[];
  subject: string;
  snippet: string;
  received_at: number;
  classification: "urgent" | "important" | "fyi" | "archive" | null;
  classification_reason: string | null;
  classification_error: string | null;
  status: "pending" | "processed" | "failed";
  // PostgREST embedded resource: drafts.email_id is UNIQUE, so this comes back
  // as a single object OR null — NOT an array. We accept array shape too for
  // defensive parsing (e.g., if the FK uniqueness ever changes).
  drafts:
    | { status: "unsent" | "sent" }
    | { status: "unsent" | "sent" }[]
    | null;
};

export type FilterValue = "all" | "urgent" | "important" | "fyi" | "archive";

export function useEmails(filter: FilterValue, pageSize: number) {
  const supabase = useSupabaseBrowser();
  const { data: me } = useMe();
  const getKey = (pageIndex: number, prev: EmailRow[] | null) => {
    if (!me) return null;
    if (prev && prev.length < pageSize) return null; // reached end
    return ["emails", filter, pageIndex, me.supabaseUserId];
  };
  return useSWRInfinite<EmailRow[]>(getKey, async (key) => {
    const [, f, idx] = key as [string, FilterValue, number, string];
    const from = idx * pageSize;
    const to = from + pageSize - 1;
    let q = supabase
      .from("emails")
      .select(
        "id, gmail_message_id, from_address, to_addresses, subject, snippet, received_at, classification, classification_reason, classification_error, status, drafts(status)",
      )
      .eq("archived_stale", false)
      .order("received_at", { ascending: false })
      .range(from, to);
    if (f !== "all") q = q.eq("classification", f);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as EmailRow[];
  });
}

// --- contacts (Personal CRM) -----------------------------------------------

// Pinned shape from GET /api/contacts?filter=...&limit=N → { ok, contacts: [...] }
// observed against src/app/api/contacts/route.ts (Agent B). The contacts table
// is RLS-scoped to the current user; the route does the SELECT and projects the
// columns listed below. All ts fields are ISO strings from Postgres; epoch
// counters are integers. aliases / manual_tags are jsonb arrays (string[]) or
// null when empty. cadence_break_days is computed by the route from last_seen_at.
// Per CONVENTIONS.md rule 2 — when route shape changes, update this type AND
// the comment.
export type ContactRow = {
  id: string;
  primary_email: string | null;
  primary_slack_user_id: string | null;
  display_name: string;
  aliases: string[] | null;
  first_seen_at: string;
  last_seen_at: string;
  last_seen_source: "email" | "slack" | "calendar" | "notion";
  total_interactions_lifetime: number;
  total_interactions_30d: number;
  cadence_break_days: number | null;
  manual_notes: string | null;
  manual_tags: string[] | null;
  archived: boolean;
};

// Pinned shape from GET /api/contacts/[id] → { ok, contact, recent_interactions }.
// recent_interactions is a union by `kind` — email/slack/calendar — interleaved
// and sorted by recency by the route. Forward-compatible: a fourth source
// (notion) can be added to the union without breaking consumers that switch on
// `kind` because TS will flag the missing case.
export type RecentInteraction =
  | {
      kind: "email";
      id: string;
      subject: string;
      snippet: string | null;
      received_at: number;
      classification: string | null;
      link: string;
    }
  | {
      kind: "slack";
      id: string;
      text: string;
      received_at: number;
      classification: string | null;
    }
  | {
      kind: "calendar";
      id: string;
      title: string;
      start_at: string;
      end_at: string;
      prep_priority: string | null;
    };

export type ContactDetailResponse = {
  ok: true;
  contact: ContactRow;
  recent_interactions: RecentInteraction[];
};

export type ContactFilter = "cadence-break" | "recent" | "all" | "archived";

// Accepts `filter | null`. Pass `null` to disable the query — mirrors
// useNotionPages C1#3 pattern. Used by CadenceFlagsView (always "cadence-break")
// AND ContactsView (filter chips). When filter is null the SWR key is null and
// no network request fires.
export function useContacts(filter: ContactFilter | null) {
  const { data: me } = useMe();
  // SWR key includes supabaseUserId so a Clerk session swap in the same tab
  // (user A signs out, user B signs in) doesn't return user A's cached
  // contacts to user B. Mirrors useNotionPages / useCalendarCredentials.
  return useSWR<ContactRow[]>(
    me && filter ? ["contacts", filter, me.supabaseUserId] : null,
    async () => {
      const res = await fetch(`/api/contacts?filter=${filter}&limit=50`);
      if (!res.ok) throw new Error(`contacts_${res.status}`);
      const data = await res.json();
      return (data.contacts ?? []) as ContactRow[];
    },
    { revalidateOnMount: true },
  );
}

export function useContact(id: string | null) {
  const { data: me } = useMe();
  return useSWR<ContactDetailResponse>(
    me && id ? ["contact", id, me.supabaseUserId] : null,
    async () => {
      const res = await fetch(`/api/contacts/${id}`);
      if (!res.ok) throw new Error(`contact_${res.status}`);
      return (await res.json()) as ContactDetailResponse;
    },
    { revalidateOnMount: true },
  );
}

// PATCH /api/contacts/[id] with the manual editable fields. On success
// invalidates the matching useContact(id) key AND all useContacts list keys so
// both the detail view and the dashboard cadence-flag list reflect the new
// values (e.g., toggling archived=true should drop the row from the list).
export function useUpdateContact() {
  const { mutate } = useSWRConfig();
  return async (
    id: string,
    body: {
      manual_notes?: string | null;
      manual_tags?: string[] | null;
      archived?: boolean;
    },
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(`/api/contacts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return { ok: false, error: `update_${res.status}` };
      // Match by prefix because the SWR key now includes supabaseUserId
      // (we don't have me here; matcher pattern is more robust).
      await mutate(
        (key) => Array.isArray(key) && key[0] === "contact" && key[1] === id,
      );
      await mutate((key) => Array.isArray(key) && key[0] === "contacts");
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "network_error",
      };
    }
  };
}

// --- decisions (Mochary 1-pager) -------------------------------------------

// Pinned shape from GET /api/decisions and POST /api/decisions (Agent B).
// `status` cycles drafted → committed → postmortem_due → reviewed per the
// decisions table state machine. linked_source_kind/id are nullable when the
// decision wasn't triggered by an inbox surface (manual entry from /decisions).
// All ts fields are ISO strings. options_considered / tags are jsonb arrays.
export type DecisionStatus =
  | "drafted"
  | "committed"
  | "postmortem_due"
  | "reviewed";

export type DecisionRow = {
  id: string;
  title: string;
  decision_made_at: string;
  context: string | null;
  options_considered: string[] | null;
  decision: string | null;
  reasoning: string | null;
  premortem: string | null;
  postmortem: string | null;
  postmortem_due_at: string | null;
  postmortem_reminded_at: string | null;
  status: DecisionStatus;
  linked_source_kind: "email" | "slack" | "notion" | "calendar" | null;
  linked_source_id: string | null;
  tags: string[] | null;
  created_at: string;
  updated_at: string;
};

export type DecisionListFilter = DecisionStatus | "all";

// Accepts `filter | null` — same null-gate pattern as useContacts. Used by
// DecisionsPostmortemDueView ("postmortem_due") AND DecisionsView (chips).
export function useDecisions(filter: DecisionListFilter | null) {
  const { data: me } = useMe();
  return useSWR<DecisionRow[]>(
    me && filter ? ["decisions", filter, me.supabaseUserId] : null,
    async () => {
      const qs =
        filter === "all" ? "limit=50" : `status=${filter}&limit=50`;
      const res = await fetch(`/api/decisions?${qs}`);
      if (!res.ok) throw new Error(`decisions_${res.status}`);
      const data = await res.json();
      return (data.decisions ?? []) as DecisionRow[];
    },
    { revalidateOnMount: true },
  );
}

export function useDecision(id: string | null) {
  const { data: me } = useMe();
  return useSWR<DecisionRow>(
    me && id ? ["decision", id, me.supabaseUserId] : null,
    async () => {
      const res = await fetch(`/api/decisions/${id}`);
      if (!res.ok) throw new Error(`decision_${res.status}`);
      const data = await res.json();
      return data.decision as DecisionRow;
    },
    { revalidateOnMount: true },
  );
}

// POST /api/decisions with Mochary fields. On success returns the new id so
// the form can router.push(`/decisions/${id}`). Also invalidates list keys so
// the list view reflects the new row on the next visit.
export type CreateDecisionBody = {
  title: string;
  context?: string | null;
  options_considered?: string[] | null;
  decision?: string | null;
  reasoning?: string | null;
  premortem?: string | null;
  tags?: string[] | null;
};

export function useCreateDecision() {
  const { mutate } = useSWRConfig();
  return async (
    body: CreateDecisionBody,
  ): Promise<{ ok: boolean; id?: string; error?: string }> => {
    try {
      const res = await fetch("/api/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        return { ok: false, error: data.error ?? `create_${res.status}` };
      }
      await mutate((key) => Array.isArray(key) && key[0] === "decisions");
      return { ok: true, id: data.decision?.id };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "network_error",
      };
    }
  };
}

export type UpdateDecisionBody = Partial<{
  title: string;
  context: string | null;
  options_considered: string[] | null;
  decision: string | null;
  reasoning: string | null;
  premortem: string | null;
  postmortem: string | null;
  status: DecisionStatus;
  tags: string[] | null;
}>;

export function useUpdateDecision() {
  const { mutate } = useSWRConfig();
  return async (
    id: string,
    body: UpdateDecisionBody,
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(`/api/decisions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return { ok: false, error: `update_${res.status}` };
      // Matcher pattern — SWR key now includes supabaseUserId.
      await mutate(
        (key) => Array.isArray(key) && key[0] === "decision" && key[1] === id,
      );
      await mutate((key) => Array.isArray(key) && key[0] === "decisions");
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "network_error",
      };
    }
  };
}

export function useDeleteDecision() {
  const { mutate } = useSWRConfig();
  return async (id: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(`/api/decisions/${id}`, { method: "DELETE" });
      if (!res.ok) return { ok: false, error: `delete_${res.status}` };
      await mutate(
        (key) => Array.isArray(key) && key[0] === "decision" && key[1] === id,
        undefined,
        { revalidate: false },
      );
      await mutate((key) => Array.isArray(key) && key[0] === "decisions");
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "network_error",
      };
    }
  };
}

// --- ingest trigger ---------------------------------------------------------

export function useTriggerIngest() {
  const { mutate } = useSWRConfig();
  return async (): Promise<{
    ok: boolean;
    error?: string;
    ingested?: number;
  }> => {
    let res: Response;
    try {
      res = await fetch("/api/ingest-emails", { method: "POST" });
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "network_error",
      };
    }
    let body: { ingested?: number; error?: string } = {};
    try {
      body = await res.json();
    } catch {
      // Empty / non-JSON body — keep going on status alone.
    }
    if (!res.ok) {
      return { ok: false, error: body.error ?? `ingest_${res.status}` };
    }
    // Revalidate dependent keys.
    mutate("/api/dashboard/me");
    mutate(
      (key) =>
        Array.isArray(key) && (key[0] === "emails" || key[0] === "email_counts"),
    );
    return { ok: true, ingested: body.ingested };
  };
}

// --- feedback notes (Commit 12 in-dashboard widget) ------------------------
//
// Pinned shapes from GET/POST /api/feedback and GET/PATCH/DELETE
// /api/feedback/[id]. `status` cycles open → addressed | dismissed per the
// product spec (no schema-enforced transitions). source_table + source_id
// are nullable when the note is sidebar-only ("global" feedback) and set
// when the user authored the note from a specific dashboard row (orange-dot
// indicator). dashboard_section is a free-text analytics tag.
//
// All ts fields are ISO strings.

export type FeedbackStatus = "open" | "addressed" | "dismissed";

export type FeedbackSourceTable =
  | "emails"
  | "slack_messages"
  | "notion_pages"
  | "calendar_events"
  | "contacts"
  | "decisions"
  | "dashboard"
  | "mh_banner";

export type FeedbackFilter = FeedbackStatus | "all";

export type FeedbackNote = {
  id: string;
  user_id: string;
  dashboard_section: string | null;
  source_table: FeedbackSourceTable | null;
  source_id: string | null;
  title: string;
  body: string | null;
  status: FeedbackStatus;
  created_at: string;
  updated_at: string;
};

// Accepts `filter | null` — same null-gate pattern as useContacts/useDecisions.
// Used by the sidebar feedback list and any filter chips. Null filter means
// the hook is idle (no fetch).
export function useFeedbackNotes(filter: FeedbackFilter | null) {
  const { data: me } = useMe();
  return useSWR<FeedbackNote[]>(
    me && filter ? ["feedback_notes", filter, me.supabaseUserId] : null,
    async () => {
      const qs =
        filter === "all" ? "status=all&limit=50" : `status=${filter}&limit=50`;
      const res = await fetch(`/api/feedback?${qs}`);
      if (!res.ok) throw new Error(`feedback_notes_${res.status}`);
      const data = await res.json();
      return (data.notes ?? []) as FeedbackNote[];
    },
    { revalidateOnMount: true },
  );
}

// Per-row scoped list — used by the orange-dot indicator. Filters to
// status=open only because the indicator only surfaces for open notes per
// spec. Null args → hook is idle.
export function useFeedbackNotesForRow(
  sourceTable: FeedbackSourceTable | null,
  sourceId: string | null,
) {
  const { data: me } = useMe();
  return useSWR<FeedbackNote[]>(
    me && sourceTable && sourceId
      ? [
          "feedback_notes",
          "for_row",
          sourceTable,
          sourceId,
          me.supabaseUserId,
        ]
      : null,
    async () => {
      const qs = new URLSearchParams({
        status: "open",
        source_table: sourceTable as string,
        source_id: sourceId as string,
        limit: "50",
      }).toString();
      const res = await fetch(`/api/feedback?${qs}`);
      if (!res.ok) throw new Error(`feedback_notes_for_row_${res.status}`);
      const data = await res.json();
      return (data.notes ?? []) as FeedbackNote[];
    },
    { revalidateOnMount: true },
  );
}

export type CreateFeedbackBody = {
  title: string;
  body?: string | null;
  dashboard_section?: string | null;
  source_table?: FeedbackSourceTable | null;
  source_id?: string | null;
};

// POST /api/feedback. On success invalidates all feedback_notes SWR keys
// (list + per-row scoped) so the sidebar and orange-dot indicators reflect
// the new row immediately.
export function useCreateFeedback() {
  const { mutate } = useSWRConfig();
  return async (
    input: CreateFeedbackBody,
  ): Promise<{ ok: boolean; error?: string; note?: FeedbackNote }> => {
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        return { ok: false, error: data.error ?? `create_${res.status}` };
      }
      await mutate(
        (key) => Array.isArray(key) && key[0] === "feedback_notes",
      );
      return { ok: true, note: data.note as FeedbackNote };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "network_error",
      };
    }
  };
}

export type UpdateFeedbackPatch = Partial<{
  title: string;
  body: string | null;
  status: FeedbackStatus;
}>;

// PATCH /api/feedback/[id]. Invalidates all feedback_notes SWR keys on
// success so status flips (open → addressed/dismissed) propagate to the
// sidebar list and the orange-dot indicator together.
export function useUpdateFeedback() {
  const { mutate } = useSWRConfig();
  return async (
    id: string,
    patch: UpdateFeedbackPatch,
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(`/api/feedback/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        // Mirror useCreateFeedback: prefer the server's data.error code
        // (e.g. "body_too_long", "invalid_body", "invalid_status") so the
        // UI can surface a precise message. Fall back to the synthetic
        // status-coded string if the body isn't JSON.
        let serverError: string | undefined;
        try {
          const data = await res.json();
          if (data && typeof data.error === "string") {
            serverError = data.error;
          }
        } catch {
          // body wasn't JSON — fall through to synthetic code
        }
        return { ok: false, error: serverError ?? `update_${res.status}` };
      }
      await mutate(
        (key) => Array.isArray(key) && key[0] === "feedback_notes",
      );
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "network_error",
      };
    }
  };
}

// DELETE /api/feedback/[id]. Hard delete — same as decisions. Invalidates
// all feedback_notes SWR keys on success.
export function useDeleteFeedback() {
  const { mutate } = useSWRConfig();
  return async (id: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(`/api/feedback/${id}`, { method: "DELETE" });
      if (!res.ok) {
        // Mirror useCreateFeedback: prefer the server's data.error code
        // (e.g. "feedback_not_found") over the synthetic status string.
        let serverError: string | undefined;
        try {
          const data = await res.json();
          if (data && typeof data.error === "string") {
            serverError = data.error;
          }
        } catch {
          // body wasn't JSON — fall through to synthetic code
        }
        return { ok: false, error: serverError ?? `delete_${res.status}` };
      }
      await mutate(
        (key) => Array.isArray(key) && key[0] === "feedback_notes",
      );
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "network_error",
      };
    }
  };
}
