"use client";

// Decision detail page. Two visual states:
//   1. Postmortem due → prominent CTA + postmortem textarea + Mark reviewed
//      button. PATCH writes postmortem text AND flips status='reviewed'.
//   2. Otherwise → read-only view with an Edit toggle. Edit mode is a single
//      form covering every Mochary field. Delete is a confirm-then-PATCH.
//
// "Postmortem due" is computed both server-side (status field) and locally
// (postmortem_due_at is in the past AND postmortem text is null) — so even if
// the cron-based status flip lags, the UI shows the CTA on time.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useDecision,
  useUpdateDecision,
  useDeleteDecision,
  type DecisionStatus,
} from "@/lib/supabase/hooks";

const STATUS_BADGE: Record<DecisionStatus, string> = {
  drafted: "bg-gray-100 text-gray-700 border-gray-200",
  committed: "bg-blue-100 text-blue-800 border-blue-200",
  postmortem_due: "bg-purple-100 text-purple-800 border-purple-200",
  reviewed: "bg-green-100 text-green-800 border-green-200",
};

export function DecisionDetailView({ decisionId }: { decisionId: string }) {
  const router = useRouter();
  const { data: d, isLoading, error } = useDecision(decisionId);
  const updateDecision = useUpdateDecision();
  const deleteDecision = useDeleteDecision();

  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  // Postmortem-specific draft state — separate from the full edit form so the
  // CTA path stays one-click for the common case (just write the postmortem).
  // Re-hydrates whenever the server-side postmortem value transitions (e.g.
  // a successful PATCH refreshes SWR and lands d.postmortem !== null) so the
  // textarea reflects the latest stored value, not a stale local snapshot.
  const [postmortemDraft, setPostmortemDraft] = useState("");
  const serverPostmortem = d?.postmortem ?? null;
  useEffect(() => {
    setPostmortemDraft(serverPostmortem ?? "");
  }, [serverPostmortem]);

  const postmortemOverdue = useMemo(() => {
    if (!d) return false;
    if (d.status === "postmortem_due") return true;
    if (
      d.postmortem_due_at &&
      d.postmortem === null &&
      new Date(d.postmortem_due_at).getTime() < Date.now()
    ) {
      return true;
    }
    return false;
  }, [d]);

  if (isLoading && !d) {
    return (
      <main className="min-h-screen p-6">
        <p className="text-sm text-gray-500">Loading…</p>
      </main>
    );
  }
  if (error || !d) {
    return (
      <main className="min-h-screen p-6">
        <Link
          href="/decisions"
          className="text-sm text-gray-600 hover:text-gray-900"
        >
          ← Decisions
        </Link>
        <p className="mt-4 text-sm text-red-600">Could not load decision.</p>
      </main>
    );
  }

  const submitPostmortem = async (markReviewed: boolean) => {
    setWorking(true);
    setActionError(null);
    const r = await updateDecision(d.id, {
      postmortem: postmortemDraft.trim() || null,
      ...(markReviewed ? { status: "reviewed" } : {}),
    });
    if (!r.ok) setActionError(r.error ?? "save_failed");
    setWorking(false);
  };

  const handleDelete = async () => {
    setWorking(true);
    setActionError(null);
    const r = await deleteDecision(d.id);
    if (r.ok) {
      router.push("/decisions");
    } else {
      setActionError(r.error ?? "delete_failed");
      setWorking(false);
    }
  };

  return (
    <main className="min-h-screen p-6">
      <div className="max-w-4xl mx-auto">
        <header className="mb-4 flex items-center justify-between">
          <Link
            href="/decisions"
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            ← Decisions
          </Link>
          {!editing && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium hover:bg-gray-50"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
              >
                Delete
              </button>
            </div>
          )}
        </header>

        <div className="mb-4 flex items-center gap-2">
          <h1 className="text-xl font-semibold text-gray-900">{d.title}</h1>
          <span
            className={`rounded-full border px-2 py-0.5 text-[10px] uppercase ${STATUS_BADGE[d.status]}`}
          >
            {d.status.replace("_", " ")}
          </span>
        </div>
        <p className="mb-6 text-xs text-gray-500">
          Decided {formatDate(d.decision_made_at)}
          {d.tags && d.tags.length > 0 && <> · {d.tags.join(" · ")}</>}
        </p>

        {postmortemOverdue && !editing && (
          <section className="mb-6 rounded-lg border border-purple-200 bg-purple-50 p-4">
            <h2 className="text-sm font-semibold text-purple-900">
              Write postmortem
            </h2>
            <p className="mt-1 text-xs text-purple-800">
              How did this decision actually play out? What surprised you?
            </p>
            <textarea
              value={postmortemDraft}
              onChange={(e) => setPostmortemDraft(e.target.value)}
              rows={5}
              className="mt-3 w-full rounded-md border border-purple-200 bg-white px-3 py-2 text-sm focus:border-purple-400 focus:outline-none"
            />
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => submitPostmortem(false)}
                disabled={working}
                className="rounded-md border border-purple-300 px-3 py-1.5 text-xs font-medium text-purple-900 hover:bg-purple-100 disabled:opacity-50"
              >
                Save draft
              </button>
              <button
                type="button"
                onClick={() => submitPostmortem(true)}
                disabled={working || postmortemDraft.trim().length === 0}
                className="rounded-md bg-purple-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-800 disabled:opacity-50"
              >
                {working ? "Saving…" : "Mark reviewed"}
              </button>
            </div>
            {actionError && (
              <p className="mt-2 text-xs text-red-600">{actionError}</p>
            )}
          </section>
        )}

        {editing ? (
          <EditDecisionForm
            decisionId={d.id}
            initial={{
              title: d.title,
              context: d.context ?? "",
              options_considered: d.options_considered ?? [],
              decision: d.decision ?? "",
              reasoning: d.reasoning ?? "",
              premortem: d.premortem ?? "",
              postmortem: d.postmortem ?? "",
              tags: d.tags ?? [],
            }}
            onCancel={() => setEditing(false)}
            onSaved={() => setEditing(false)}
          />
        ) : (
          <ReadOnlyDecision d={d} />
        )}

        {confirmDelete && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
            <div className="w-full max-w-md rounded-lg bg-white p-5">
              <h3 className="text-base font-semibold text-gray-900">
                Delete this decision?
              </h3>
              <p className="mt-2 text-sm text-gray-700">
                The decision, postmortem, and any linked reasoning will be
                permanently removed. This can&apos;t be undone.
              </p>
              <div className="mt-4 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={working}
                  className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50"
                >
                  {working ? "Deleting…" : "Delete decision"}
                </button>
              </div>
              {actionError && (
                <p className="mt-2 text-xs text-red-600">{actionError}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function ReadOnlyDecision({
  d,
}: {
  d: NonNullable<ReturnType<typeof useDecision>["data"]>;
}) {
  return (
    <div className="space-y-4">
      <Section title="Context" body={d.context} />
      <Section
        title="Options considered"
        bodyList={d.options_considered ?? []}
      />
      <Section title="Decision" body={d.decision} />
      <Section title="Reasoning" body={d.reasoning} />
      <Section title="Premortem" body={d.premortem} />
      {d.postmortem !== null && (
        <Section title="Postmortem" body={d.postmortem} highlight />
      )}
    </div>
  );
}

function Section({
  title,
  body,
  bodyList,
  highlight,
}: {
  title: string;
  body?: string | null;
  bodyList?: string[];
  highlight?: boolean;
}) {
  const empty = bodyList ? bodyList.length === 0 : !body;
  return (
    <section
      className={`rounded-lg border p-4 ${
        highlight
          ? "border-green-200 bg-green-50"
          : "border-gray-200 bg-white"
      }`}
    >
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
        {title}
      </h3>
      {empty ? (
        <p className="mt-2 text-sm italic text-gray-400">Not filled in.</p>
      ) : bodyList ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-gray-800">
          {bodyList.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 whitespace-pre-wrap text-sm text-gray-800">
          {body}
        </p>
      )}
    </section>
  );
}

function EditDecisionForm({
  decisionId,
  initial,
  onCancel,
  onSaved,
}: {
  decisionId: string;
  initial: {
    title: string;
    context: string;
    options_considered: string[];
    decision: string;
    reasoning: string;
    premortem: string;
    postmortem: string;
    tags: string[];
  };
  onCancel: () => void;
  onSaved: () => void;
}) {
  const updateDecision = useUpdateDecision();
  const [title, setTitle] = useState(initial.title);
  const [context, setContext] = useState(initial.context);
  const [optionsText, setOptionsText] = useState(
    initial.options_considered.join("\n"),
  );
  const [decision, setDecision] = useState(initial.decision);
  const [reasoning, setReasoning] = useState(initial.reasoning);
  const [premortem, setPremortem] = useState(initial.premortem);
  const [postmortem, setPostmortem] = useState(initial.postmortem);
  const [tagsText, setTagsText] = useState(initial.tags.join(", "));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const options = optionsText
      .split("\n")
      .map((o) => o.trim())
      .filter(Boolean);
    const tags = tagsText
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const r = await updateDecision(decisionId, {
      title: title.trim(),
      context: context.trim() || null,
      options_considered: options.length > 0 ? options : null,
      decision: decision.trim() || null,
      reasoning: reasoning.trim() || null,
      premortem: premortem.trim() || null,
      postmortem: postmortem.trim() || null,
      tags: tags.length > 0 ? tags : null,
    });
    setSubmitting(false);
    if (r.ok) onSaved();
    else setError(r.error ?? "save_failed");
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border border-gray-200 bg-white p-4"
    >
      <h2 className="mb-3 text-sm font-semibold text-gray-900">
        Edit decision
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
      <Field label="Context">
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
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        />
      </Field>
      <Field label="Decision">
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
      <Field label="Premortem">
        <textarea
          value={premortem}
          onChange={(e) => setPremortem(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        />
      </Field>
      <Field label="Postmortem">
        <textarea
          value={postmortem}
          onChange={(e) => setPostmortem(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
        />
      </Field>
      <Field label="Tags (comma-separated)">
        <input
          type="text"
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
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
          disabled={submitting || title.trim().length === 0}
          className="rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Save changes"}
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
