"use client";

// Decisions list + create form. The create form follows the Mochary 1-pager
// structure exactly (Tab 2 spec point 7) — title → context → options →
// decision → reasoning → premortem. Postmortem is INTENTIONALLY OMITTED here
// per spec: that field is hidden until the reminder fires and only appears on
// the detail page when status='postmortem_due'. v0 ships the form inline
// (expand-in-place) rather than a modal so the founder doesn't lose visual
// continuity with the list of past decisions.

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useDecisions,
  useCreateDecision,
  type DecisionListFilter,
  type DecisionStatus,
} from "@/lib/supabase/hooks";

const FILTERS: { value: DecisionListFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "drafted", label: "Drafted" },
  { value: "committed", label: "Committed" },
  { value: "postmortem_due", label: "Postmortem due" },
  { value: "reviewed", label: "Reviewed" },
];

const STATUS_BADGE: Record<DecisionStatus, string> = {
  drafted: "bg-gray-100 text-gray-700 border-gray-200",
  committed: "bg-blue-100 text-blue-800 border-blue-200",
  postmortem_due: "bg-purple-100 text-purple-800 border-purple-200",
  reviewed: "bg-green-100 text-green-800 border-green-200",
};

export function DecisionsView() {
  const router = useRouter();
  const [filter, setFilter] = useState<DecisionListFilter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const { data: decisions, isLoading, error } = useDecisions(filter);

  return (
    <main className="min-h-screen p-6">
      <div className="max-w-4xl mx-auto">
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-xl font-semibold">Decisions</h1>
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard"
              className="text-sm text-gray-600 hover:text-gray-900"
            >
              ← Dashboard
            </Link>
            <button
              type="button"
              onClick={() => setCreateOpen((v) => !v)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50"
            >
              {createOpen ? "Close" : "New decision"}
            </button>
          </div>
        </header>

        {createOpen && (
          <CreateDecisionForm
            onCancel={() => setCreateOpen(false)}
            onCreated={(id) => router.push(`/decisions/${id}`)}
          />
        )}

        <div className="mb-4 flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              className={`text-xs px-2.5 py-1 rounded-full border transition ${
                filter === f.value
                  ? "bg-black text-white border-black"
                  : "bg-white text-gray-600 border-gray-300 hover:border-gray-500"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {error && (
          <p className="text-sm text-red-600">Could not load decisions.</p>
        )}
        {isLoading && !decisions && (
          <p className="text-sm text-gray-500">Loading…</p>
        )}
        {decisions && decisions.length === 0 && !isLoading && (
          <p className="text-sm text-gray-500">
            No decisions in this view yet.
          </p>
        )}

        <ul className="divide-y divide-gray-200 border-y border-gray-200">
          {decisions?.map((d) => (
            <li key={d.id}>
              <Link
                href={`/decisions/${d.id}`}
                className="flex items-baseline justify-between gap-3 py-3 px-2 -mx-2 hover:bg-gray-50"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-gray-900">
                      {d.title}
                    </span>
                    <span
                      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase ${STATUS_BADGE[d.status]}`}
                    >
                      {d.status.replace("_", " ")}
                    </span>
                  </div>
                  {d.tags && d.tags.length > 0 && (
                    <div className="mt-0.5 truncate text-xs text-gray-500">
                      {d.tags.join(" · ")}
                    </div>
                  )}
                </div>
                <span className="shrink-0 text-xs text-gray-500">
                  {formatDate(d.decision_made_at)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}

// Mochary 1-pager create form. Fields in spec order. options_considered is
// captured as a textarea — one option per line — and split on save so the
// route gets a string[]. postmortem is NOT in this form (spec point 7).
function CreateDecisionForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const createDecision = useCreateDecision();
  const [title, setTitle] = useState("");
  const [context, setContext] = useState("");
  const [optionsText, setOptionsText] = useState("");
  const [decision, setDecision] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [premortem, setPremortem] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = title.trim().length > 0 && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const options = optionsText
      .split("\n")
      .map((o) => o.trim())
      .filter(Boolean);
    const r = await createDecision({
      title: title.trim(),
      context: context.trim() || null,
      options_considered: options.length > 0 ? options : null,
      decision: decision.trim() || null,
      reasoning: reasoning.trim() || null,
      premortem: premortem.trim() || null,
    });
    setSubmitting(false);
    if (r.ok && r.id) {
      onCreated(r.id);
    } else {
      setError(r.error ?? "create_failed");
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="mb-6 rounded-lg border border-gray-200 bg-white p-4"
    >
      <h2 className="mb-3 text-sm font-semibold text-gray-900">
        New decision (Mochary 1-pager)
      </h2>

      <Field label="Title" required>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        />
      </Field>

      <Field label="Context — what's the situation?">
        <textarea
          value={context}
          onChange={(e) => setContext(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        />
      </Field>

      <Field label="Options considered (one per line)">
        <textarea
          value={optionsText}
          onChange={(e) => setOptionsText(e.target.value)}
          rows={3}
          placeholder={"Option A\nOption B\nOption C"}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        />
      </Field>

      <Field label="Decision made">
        <textarea
          value={decision}
          onChange={(e) => setDecision(e.target.value)}
          rows={2}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        />
      </Field>

      <Field label="Reasoning">
        <textarea
          value={reasoning}
          onChange={(e) => setReasoning(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        />
      </Field>

      <Field label="Premortem — what could go wrong?">
        <textarea
          value={premortem}
          onChange={(e) => setPremortem(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        />
      </Field>

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Save decision"}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-xs font-medium text-gray-700">
        {label}
        {required && <span className="text-red-600"> *</span>}
      </span>
      {children}
    </label>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
