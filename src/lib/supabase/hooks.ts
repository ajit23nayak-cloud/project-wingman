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
// every successful response — lastIngestedAt and gmailReauthNeededAt are
// nullable (brand-new user before first ingest; flag never set), but the
// other three are always present strings/booleans. When the API contract
// changes, update this type AND the comment. Per CONVENTIONS.md "Pin the
// observed shape as a code comment."
export type MeData = {
  supabaseUserId: string;
  email: string;
  lastIngestedAt: number | null;
  gmailReauthNeeded: boolean;
  gmailReauthNeededAt: string | null;
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
