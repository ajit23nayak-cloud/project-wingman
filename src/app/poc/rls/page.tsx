"use client";

// Day 9 RLS POC. Proves Clerk JWT -> Supabase RLS row-isolation works.
// Three assertions visible on screen:
//   A. anon + Clerk JWT SELECT users -> exactly 1 row (own clerk_user_id)
//   B. anon (no JWT) SELECT users -> 0 rows (RLS default deny)
//   C. service_role count(*) users >= A.count + decoy seeded (RLS bypassed)
// If A+B green at mount and C green after "Seed decoy", RLS pattern validated.

import { useAuth, useUser } from "@clerk/nextjs";
import { useCallback, useEffect, useState } from "react";
import {
  makeSupabaseAnonClient,
  makeSupabaseBrowserClient,
} from "@/lib/supabase/client";

type AssertionState = "pending" | "pass" | "fail";

type Result = {
  state: AssertionState;
  detail: string;
};

const PENDING: Result = { state: "pending", detail: "not run yet" };

export default function RlsPocPage() {
  const { isLoaded, isSignedIn, user } = useUser();
  const { getToken } = useAuth();
  const [a, setA] = useState<Result>(PENDING);
  const [b, setB] = useState<Result>(PENDING);
  const [c, setC] = useState<Result>(PENDING);
  const [decoyId, setDecoyId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const runAB = useCallback(async () => {
    if (!user) return;
    setA(PENDING);
    setB(PENDING);

    const authed = makeSupabaseBrowserClient(() =>
      getToken({ template: "supabase" }),
    );

    const upsertRes = await authed.from("users").upsert(
      {
        clerk_user_id: user.id,
        email: user.primaryEmailAddress?.emailAddress ?? "",
        paid_tier: false,
      },
      { onConflict: "clerk_user_id" },
    );
    if (upsertRes.error) {
      setA({
        state: "fail",
        detail: `upsert failed: ${upsertRes.error.message}`,
      });
    } else {
      const { data, error } = await authed.from("users").select("*");
      if (error) {
        setA({ state: "fail", detail: `select failed: ${error.message}` });
      } else if (
        data.length === 1 &&
        data[0].clerk_user_id === user.id
      ) {
        setA({ state: "pass", detail: `1 row returned, own clerk_user_id` });
      } else {
        setA({
          state: "fail",
          detail: `expected 1 row (own); got ${data.length}: ${JSON.stringify(
            data.map((r) => r.clerk_user_id),
          )}`,
        });
      }
    }

    const anon = makeSupabaseAnonClient();
    const { data: anonData, error: anonErr } = await anon
      .from("users")
      .select("*");
    if (anonErr) {
      setB({ state: "fail", detail: `select failed: ${anonErr.message}` });
    } else if (anonData.length === 0) {
      setB({ state: "pass", detail: "0 rows returned (RLS default deny)" });
    } else {
      setB({
        state: "fail",
        detail: `expected 0; got ${anonData.length} rows`,
      });
    }
  }, [getToken, user]);

  const runC = useCallback(async () => {
    setC(PENDING);
    const res = await fetch("/api/poc/count-all");
    const body = await res.json();
    if (!res.ok || !body.ok) {
      setC({ state: "fail", detail: `count-all failed: ${body.error ?? res.status}` });
      return;
    }
    const minExpected = decoyId ? 2 : 1;
    if (body.count >= minExpected) {
      setC({
        state: "pass",
        detail: `service_role saw ${body.count} rows (expected >= ${minExpected})`,
      });
    } else {
      setC({
        state: "fail",
        detail: `service_role saw ${body.count} rows; expected >= ${minExpected}`,
      });
    }
  }, [decoyId]);

  useEffect(() => {
    if (isLoaded && isSignedIn) {
      void runAB();
      void runC();
    }
  }, [isLoaded, isSignedIn, runAB, runC]);

  const seedDecoy = async () => {
    setBusy(true);
    const res = await fetch("/api/poc/seed-decoy", { method: "POST" });
    const body = await res.json();
    setBusy(false);
    if (body.ok) {
      setDecoyId(body.decoyClerkId);
      await runAB();
      await runC();
    } else {
      alert(`seed failed: ${body.error}`);
    }
  };

  const clearDecoy = async () => {
    setBusy(true);
    const res = await fetch("/api/poc/clear-decoy", { method: "POST" });
    const body = await res.json();
    setBusy(false);
    if (body.ok) {
      setDecoyId(null);
      await runAB();
      await runC();
    } else {
      alert(`clear failed: ${body.error}`);
    }
  };

  if (!isLoaded) return <main style={S.main}>Loading Clerk…</main>;
  if (!isSignedIn) {
    return (
      <main style={S.main}>
        <h1>RLS POC</h1>
        <p>Sign in first — this page tests Clerk JWT scoping.</p>
      </main>
    );
  }

  return (
    <main style={S.main}>
      <h1 style={S.h1}>RLS POC — Clerk JWT × Supabase</h1>
      <p style={S.sub}>
        Signed in as <code>{user?.id}</code>
      </p>

      <Row label="A. anon + JWT SELECT (expect 1 own row)" result={a} />
      <Row label="B. anon-only SELECT (expect 0 rows)" result={b} />
      <Row
        label={`C. service_role count(*) (expect >= ${decoyId ? 2 : 1})`}
        result={c}
      />

      <div style={S.controls}>
        <button onClick={seedDecoy} disabled={busy} style={S.btn}>
          Seed decoy row
        </button>
        <button onClick={clearDecoy} disabled={busy} style={S.btn}>
          Clear decoy rows
        </button>
        <button
          onClick={() => {
            void runAB();
            void runC();
          }}
          disabled={busy}
          style={S.btn}
        >
          Re-run
        </button>
      </div>

      <p style={S.footer}>
        Pass criteria: A green, B green at mount; click <em>Seed decoy</em>, then
        A must stay 1 row, C must go to 2+. If all three green after seeding,
        RLS isolation is proven and Phase 1 schema port is unblocked.
      </p>
    </main>
  );
}

function Row({ label, result }: { label: string; result: Result }) {
  const color =
    result.state === "pass"
      ? "#1f8a3a"
      : result.state === "fail"
        ? "#b3261e"
        : "#888";
  return (
    <div style={S.row}>
      <span style={{ ...S.badge, background: color }}>
        {result.state.toUpperCase()}
      </span>
      <span style={S.label}>{label}</span>
      <span style={S.detail}>{result.detail}</span>
    </div>
  );
}

const S = {
  main: {
    maxWidth: 760,
    margin: "40px auto",
    fontFamily: "ui-monospace, monospace",
    padding: 24,
    color: "#111",
  } as const,
  h1: { fontSize: 22, marginBottom: 4 } as const,
  sub: { color: "#555", marginBottom: 24 } as const,
  row: {
    display: "grid",
    gridTemplateColumns: "84px 1fr",
    gap: 12,
    rowGap: 4,
    alignItems: "center",
    padding: "10px 0",
    borderBottom: "1px solid #eee",
  } as const,
  badge: {
    color: "white",
    padding: "2px 8px",
    borderRadius: 4,
    fontSize: 12,
    textAlign: "center" as const,
  } as const,
  label: { fontWeight: 600 } as const,
  detail: { gridColumn: "2", color: "#666", fontSize: 13 } as const,
  controls: { display: "flex", gap: 8, marginTop: 24 } as const,
  btn: {
    padding: "8px 14px",
    border: "1px solid #ccc",
    background: "#f5f5f5",
    cursor: "pointer",
    borderRadius: 4,
  } as const,
  footer: {
    marginTop: 32,
    fontSize: 13,
    color: "#666",
    lineHeight: 1.5,
  } as const,
};
