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

export type MeData = {
  supabaseUserId: string;
  email: string;
  lastIngestedAt: number | null;
};

export function useMe() {
  return useSWR<MeData>("/api/dashboard/me", async (url: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`me_fetch_${res.status}`);
    return res.json();
  });
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
  drafts: { status: "unsent" | "sent" }[];
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
