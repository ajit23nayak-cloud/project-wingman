"use client";

// Daily ritual surface. Renders morning + evening cards stacked (Tab 2 19:10
// UTC lock flag D). Branches on user state per the matrix in
// MH_UI_SPEC.md §"User-state matrix":
//   State A (mhStyle set):    canonical per-style ritual
//   State B (null, no skips): redirect to /assessment
//   State C/D (null, skipped): mixed-mode ritual
//   State F (was set, deleted): treated as B by the same gating
//
// UPSERT semantics on submit: server SELECTs today's row first, UPDATEs if
// it exists, INSERTs if not. Same UX whether you're filling for the first
// time or editing your earlier entry — both flows render this form with
// today's existing answers prefilled.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  useMe,
  useTodayRitual,
  useStreak,
  type RitualSession,
} from "@/lib/supabase/hooks";
import {
  decomposeFromStorage,
  fieldsFor,
  variantFor,
  type RitualField,
  type RitualType,
  type RitualVariant,
} from "@/lib/mh/ritual";

type FieldValues = Record<string, string | number | undefined>;

function extractPrefill(session: RitualSession | null): FieldValues {
  if (!session) return {};
  return decomposeFromStorage(session.numeric_data, session.text_data);
}

function FieldRow({
  field,
  value,
  onChange,
  disabled,
}: {
  field: RitualField;
  value: string | number | undefined;
  onChange: (next: string | number) => void;
  disabled: boolean;
}) {
  if (field.kind === "text") {
    return (
      <div>
        <label className="block text-sm font-medium text-gray-700">
          {field.prompt}
        </label>
        <textarea
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
          disabled={disabled}
          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black focus:border-black disabled:opacity-50"
        />
      </div>
    );
  }
  if (field.kind === "number") {
    return (
      <div>
        <label className="block text-sm font-medium text-gray-700">
          {field.prompt}
        </label>
        <div className="mt-2 flex items-center gap-1">
          {Array.from({ length: field.max - field.min + 1 }, (_, i) => {
            const n = field.min + i;
            const active = value === n;
            return (
              <button
                key={n}
                type="button"
                onClick={() => onChange(n)}
                disabled={disabled}
                className={`h-8 w-8 rounded-full border text-xs font-medium transition disabled:opacity-50 ${
                  active
                    ? "bg-black text-white border-black"
                    : "bg-white text-gray-700 border-gray-300 hover:border-gray-500"
                }`}
              >
                {n}
              </button>
            );
          })}
        </div>
      </div>
    );
  }
  // categorical
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700">
        {field.prompt}
      </label>
      <div className="mt-2 flex items-center gap-2">
        {field.options.map((opt) => {
          const active = value === opt;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(opt)}
              disabled={disabled}
              className={`rounded-full border px-3 py-1 text-xs font-medium capitalize transition disabled:opacity-50 ${
                active
                  ? "bg-black text-white border-black"
                  : "bg-white text-gray-700 border-gray-300 hover:border-gray-500"
              }`}
            >
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RitualCard({
  title,
  description,
  type,
  variant,
  prefill,
  onSubmitted,
}: {
  title: string;
  description: string;
  type: RitualType;
  variant: RitualVariant;
  prefill: FieldValues;
  onSubmitted: () => void;
}) {
  const fields = useMemo(() => fieldsFor(variant, type), [variant, type]);

  // One-time hydration from prefill. The previous `useState(prefill)` only
  // read the prop on first mount, but DailyView's parent SWR fetch resolves
  // AFTER mount — so empty prefill at t=0 stuck around even when today.data
  // arrived at t=N. Tab 2 caught this in browser-verify (20:30 patch
  // round): saved morning rows rendered as empty forms on /daily revisit,
  // breaking the "edit your earlier entry" UX.
  //
  // Pattern: lazy useState seeded from prefill (so cache-hit mounts render
  // with data already in state, no flicker), plus a useRef guard so once
  // we've hydrated we never overwrite user edits with a re-incoming prefill
  // (which would happen if SWR revalidates mid-typing).
  const [values, setValues] = useState<FieldValues>(() => prefill);
  const hydratedRef = useRef(Object.keys(prefill).length > 0);
  useEffect(() => {
    if (hydratedRef.current) return;
    if (Object.keys(prefill).length === 0) return;
    setValues(prefill);
    hydratedRef.current = true;
  }, [prefill]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const handleField = (key: string, next: string | number) => {
    setValues((prev) => ({ ...prev, [key]: next }));
    setSavedAt(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const raw: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      if (v !== undefined && v !== "") raw[k] = v;
    }
    try {
      const res = await fetch("/api/mh/ritual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, raw }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? `submit_${res.status}`);
        setSubmitting(false);
        return;
      }
      setSavedAt(Date.now());
      setSubmitting(false);
      onSubmitted();
    } catch {
      setError("network_error");
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-6">
      <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
      <p className="mt-1 text-sm text-gray-600">{description}</p>
      <form onSubmit={handleSubmit} className="mt-5 space-y-5">
        {fields.map((field) => (
          <FieldRow
            key={field.key}
            field={field}
            value={values[field.key]}
            onChange={(next) => handleField(field.key, next)}
            disabled={submitting}
          />
        ))}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-black text-white px-4 py-1.5 text-sm font-medium hover:bg-gray-800 disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Save"}
          </button>
          {savedAt && !error && (
            <span className="text-xs text-green-700">Saved.</span>
          )}
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
      </form>
    </section>
  );
}

export function DailyView() {
  const { data: me, error: meError } = useMe();
  const today = useTodayRitual();
  const streak = useStreak();

  // State B (null + 0 skips) → redirect to /assessment. We do this in an
  // effect, not at render time, so the empty <main> shell renders briefly
  // before navigation rather than hydration warnings on a redirect.
  useEffect(() => {
    if (me === undefined) return;
    if (me.mhStyle === null && me.mhAssessmentSkipCount === 0) {
      window.location.href = "/assessment";
    }
  }, [me]);

  if (meError) {
    return (
      <main className="min-h-screen p-6">
        <div className="max-w-2xl mx-auto">
          <Link
            href="/dashboard"
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            ← Back to dashboard
          </Link>
          <p className="mt-6 text-sm text-red-600">
            Could not load your account. {meError.message}
          </p>
        </div>
      </main>
    );
  }

  if (me === undefined) {
    return (
      <main className="min-h-screen p-6">
        <div className="max-w-2xl mx-auto">
          <p className="text-gray-500 text-sm">Loading…</p>
        </div>
      </main>
    );
  }

  // State B users will be redirected by the effect above; render the empty
  // shell while that happens.
  if (me.mhStyle === null && me.mhAssessmentSkipCount === 0) {
    return <main className="min-h-screen p-6" />;
  }

  const variant: RitualVariant = variantFor(me.mhStyle);
  const morningPrefill = extractPrefill(today.data?.morning ?? null);
  const eveningPrefill = extractPrefill(today.data?.evening ?? null);

  const todayLabel = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <main className="min-h-screen bg-gray-50">
      <nav className="border-b border-gray-200 bg-white">
        <div className="max-w-2xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link
            href="/dashboard"
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            ← Back to dashboard
          </Link>
          {streak.data && streak.data.streakDays > 0 && (
            <div className="text-xs text-gray-700">
              <span className="font-semibold">{streak.data.streakDays}</span>{" "}
              day{streak.data.streakDays === 1 ? "" : "s"} streak
            </div>
          )}
        </div>
      </nav>

      <div className="max-w-2xl mx-auto px-6 py-8">
        <div className="text-xs uppercase tracking-wide text-gray-500">
          Daily ritual · {todayLabel}
        </div>
        <h1 className="mt-2 text-2xl font-semibold">
          Take a few minutes with yourself.
        </h1>
        {variant === "mixed" && (
          <p className="mt-2 text-sm text-gray-600">
            Showing the balanced version of the ritual. Want to{" "}
            <Link
              href="/assessment"
              className="text-gray-900 underline hover:no-underline"
            >
              personalize this
            </Link>
            ? Two minutes.
          </p>
        )}

        <div className="mt-8 space-y-6">
          <RitualCard
            title="Morning"
            description="Set your direction. ~3-4 minutes."
            type="morning_ritual"
            variant={variant}
            prefill={morningPrefill}
            onSubmitted={() => {
              void today.mutate();
              void streak.mutate();
            }}
          />
          <RitualCard
            title="Evening"
            description="Reflect on the day. ~3-4 minutes."
            type="evening_ritual"
            variant={variant}
            prefill={eveningPrefill}
            onSubmitted={() => {
              void today.mutate();
              void streak.mutate();
            }}
          />
        </div>
      </div>
    </main>
  );
}
