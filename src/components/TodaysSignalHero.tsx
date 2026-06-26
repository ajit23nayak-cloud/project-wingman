"use client";

// Today's Signal hero — full-width cream card at the top of /dashboard,
// rendered above the welcome row (Commit 18). Reads the latest
// dashboard_signals row via useTodaysSignal(); falls back to a quiet
// placeholder when no signal generated in the last 60 min.
//
// Pure render — Cred chrome (cream-card bg + gold ✦ flourish + lowercase
// summary text). Refresh cadence is driven by dashboard-signal-refresh
// cron (every hour at :10 per migration 0025).

import { useTodaysSignal } from "@/lib/supabase/hooks";

function isFresh(generatedAt: string): boolean {
  const age = Date.now() - new Date(generatedAt).getTime();
  return age < 60 * 60 * 1000; // 60 min
}

function formatAge(generatedAt: string): string {
  const minutes = Math.floor(
    (Date.now() - new Date(generatedAt).getTime()) / 60000,
  );
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr ago`;
}

export function TodaysSignalHero() {
  const { data, isLoading } = useTodaysSignal();

  if (isLoading) return null;

  const fresh = data && isFresh(data.generated_at);

  return (
    <section
      className="mx-auto mt-6 max-w-4xl rounded-[10px] border px-6 py-5"
      style={{
        background: "var(--cred-card-bg)",
        borderColor: "var(--cred-border)",
      }}
    >
      <div
        className="cred-ui-lower mb-2 flex items-center gap-2 text-[11px] font-medium tracking-[0.04em]"
        style={{ color: "var(--cred-text-meta)" }}
      >
        <span aria-hidden="true" style={{ color: "var(--cred-flourish)" }}>
          ✦
        </span>
        today&apos;s signal
        {fresh && data && (
          <span className="tabular-nums">· {formatAge(data.generated_at)}</span>
        )}
      </div>
      {fresh && data ? (
        <p
          className="cred-ui-lower text-[18px] font-light leading-[1.4] tracking-[-0.01em]"
          style={{ color: "var(--cred-text-primary)" }}
        >
          {data.summary_text}
        </p>
      ) : (
        <p
          className="cred-ui-lower text-[15px] italic"
          style={{ color: "var(--cred-text-secondary)" }}
        >
          we&apos;ll have today&apos;s signal ready by 7am ist tomorrow.
        </p>
      )}
    </section>
  );
}
