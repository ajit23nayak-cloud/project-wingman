"use client";

// Evening reflection banner (Commit 18). Renders at user's local 21:00-23:00
// when no daily_reflections row exists for today. Quick tone picker
// (rough / steady / great) + free-text. Submits via useSubmitReflection,
// hides on success OR Esc OR auto-dismiss at 23:00 (via parent gating
// useShouldShowEveningBanner).
//
// Mounted by DashboardView inside the welcome stack (before TodaysSignalHero).
// No animation library; plain CSS transition on opacity for the dismiss.

import { useState } from "react";
import { useSubmitReflection } from "@/lib/supabase/hooks";

type Tone = "rough" | "steady" | "great" | null;

const TONES: Array<{ value: Exclude<Tone, null>; label: string }> = [
  { value: "rough", label: "rough" },
  { value: "steady", label: "steady" },
  { value: "great", label: "great" },
];

export function EveningReflectionBanner() {
  const submit = useSubmitReflection();
  const [tone, setTone] = useState<Tone>(null);
  const [freeText, setFreeText] = useState("");
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (dismissed) return null;

  const handleSubmit = async () => {
    if (!tone && !freeText.trim()) {
      setError("Pick a tone or jot a line.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await submit({
      tone,
      free_text: freeText.trim() || null,
    });
    setBusy(false);
    if (!res.ok) {
      setError("Couldn't save. Try again in a moment.");
      return;
    }
    setDismissed(true);
  };

  return (
    <section
      role="region"
      aria-label="Evening reflection"
      className="mx-auto mt-6 max-w-4xl rounded-[10px] border px-6 py-5"
      style={{
        background: "var(--cred-grad-lavender)",
        borderColor: "var(--cred-border)",
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div
            className="cred-ui-lower mb-2 flex items-center gap-2 text-[11px] font-medium tracking-[0.04em]"
            style={{ color: "#5a3d8c" }}
          >
            <span aria-hidden="true">✦</span>
            end of day
          </div>
          <p
            className="text-[18px] font-light tracking-[-0.01em]"
            style={{ color: "var(--cred-text-primary)" }}
          >
            How did today go?
          </p>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setDismissed(true)}
          className="text-[18px] leading-none"
          style={{ color: "#5a3d8c", opacity: 0.7 }}
        >
          ×
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {TONES.map((t) => {
          const active = tone === t.value;
          return (
            <button
              key={t.value}
              type="button"
              onClick={() => setTone(active ? null : t.value)}
              className="cred-ui-lower rounded-[4px] border px-3 py-1.5 text-[12px] font-medium tracking-[0.02em]"
              style={
                active
                  ? {
                      background: "var(--cred-text-primary)",
                      color: "var(--cred-page-bg)",
                      borderColor: "var(--cred-text-primary)",
                    }
                  : {
                      background: "rgba(255,255,255,0.5)",
                      color: "var(--cred-text-primary)",
                      borderColor: "var(--cred-border)",
                    }
              }
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <textarea
        value={freeText}
        onChange={(e) => setFreeText(e.target.value)}
        rows={2}
        maxLength={1000}
        placeholder="one line on what to carry into tomorrow (optional)"
        className="mt-3 w-full rounded-[6px] border px-3 py-2 text-[14px] leading-[1.5]"
        style={{
          background: "rgba(255,255,255,0.6)",
          borderColor: "var(--cred-border)",
          color: "var(--cred-text-primary)",
        }}
      />

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={busy}
          className="cred-ui-lower rounded-[4px] px-4 py-1.5 text-[13px] font-medium tracking-[0.01em] disabled:opacity-60"
          style={{
            background: "var(--cred-text-primary)",
            color: "var(--cred-page-bg)",
          }}
        >
          {busy ? "saving…" : "save reflection"}
        </button>
        {error && (
          <span className="text-[12px]" style={{ color: "#b8425a" }}>
            {error}
          </span>
        )}
      </div>
    </section>
  );
}
