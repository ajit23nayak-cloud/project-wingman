"use client";

// Help me think — modal entry point. Triage picker → one of 4 routes:
//   decision (OPA: outcome / purpose / action)
//   inquiry  (Katie's 4 questions + turnaround)
//   drained  (energy audit: type 3-7 tasks + R/Y/G each)
//   other    (chat fallback, 8-turn hard cap)
//
// All locked per Tab 2 23:35 UTC + Ajit "all 8 per Tab 2 rec" confirmation.
// State stays in this component; submission posts to /api/mh/on_demand
// (one-shot per session). Chat uses /api/mh/chat per-turn but only persists
// the final transcript via /api/mh/on_demand at session-end.

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  useSaveOnDemand,
  useChatTurn,
  type ChatMessage,
} from "@/lib/supabase/hooks";
import { CHAT_TRANSCRIPT_MAX_TURNS } from "@/lib/mh/helpMeThink";

type View = "triage" | "decision" | "inquiry" | "drained" | "other";

const CHAT_MAX_USER_TURNS = CHAT_TRANSCRIPT_MAX_TURNS / 2;

export function HelpMeThinkModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [view, setView] = useState<View>("triage");

  // Reset state to triage when the modal closes so the next open is clean.
  const handleClose = () => {
    setView("triage");
    onClose();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={handleClose}
    >
      <div
        className="w-full max-w-lg rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-gray-900">
            Help me think
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="text-sm text-gray-500 hover:text-gray-900"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-5">
          {view === "triage" && <TriagePicker onPick={setView} />}
          {view === "decision" && (
            <DecisionRoute onDone={handleClose} onBack={() => setView("triage")} />
          )}
          {view === "inquiry" && (
            <InquiryRoute onDone={handleClose} onBack={() => setView("triage")} />
          )}
          {view === "drained" && (
            <DrainedRoute onDone={handleClose} onBack={() => setView("triage")} />
          )}
          {view === "other" && (
            <ChatRoute onDone={handleClose} onBack={() => setView("triage")} />
          )}
        </div>
      </div>
    </div>
  );
}

function TriagePicker({ onPick }: { onPick: (v: View) => void }) {
  return (
    <div>
      <p className="text-sm text-gray-700">What&apos;s on your mind?</p>
      <div className="mt-4 space-y-2">
        <TriageButton onClick={() => onPick("decision")}>
          I&apos;m stuck on a decision
        </TriageButton>
        <TriageButton onClick={() => onPick("inquiry")}>
          I&apos;m carrying a stressful thought
        </TriageButton>
        <TriageButton onClick={() => onPick("drained")}>
          I&apos;m drained or can&apos;t focus
        </TriageButton>
        <TriageButton onClick={() => onPick("other")}>Something else</TriageButton>
      </div>
    </div>
  );
}

function TriageButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-md border border-gray-300 bg-white px-4 py-3 text-left text-sm font-medium text-gray-800 hover:border-gray-500 hover:bg-gray-50"
    >
      {children}
    </button>
  );
}

function BackHeader({ onBack, title }: { onBack: () => void; title: string }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <button
        type="button"
        onClick={onBack}
        className="text-xs text-gray-600 hover:text-gray-900"
      >
        ← Back
      </button>
      <span className="text-sm font-medium text-gray-900">{title}</span>
    </div>
  );
}

// --- Decision (OPA) ---------------------------------------------------------

function DecisionRoute({
  onDone,
  onBack,
}: {
  onDone: () => void;
  onBack: () => void;
}) {
  const save = useSaveOnDemand();
  const [outcome, setOutcome] = useState("");
  const [purpose, setPurpose] = useState("");
  const [action, setAction] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    outcome.trim().length > 0 ||
    purpose.trim().length > 0 ||
    action.trim().length > 0;

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    const res = await save("decision", { outcome, purpose, action });
    if (!res.ok) {
      setError(res.error ?? "save_failed");
      setSubmitting(false);
      return;
    }
    onDone();
  };

  return (
    <div>
      <BackHeader onBack={onBack} title="Decision — Outcome / Purpose / Action" />
      <p className="text-xs text-gray-600">
        Three questions to shape the decision. Be specific where you can; fuzzy
        is fine where you can&apos;t.
      </p>
      <div className="mt-4 space-y-3">
        <FieldText
          label="Outcome — what does success look like?"
          value={outcome}
          onChange={setOutcome}
          disabled={submitting}
        />
        <FieldText
          label="Purpose — why does this matter?"
          value={purpose}
          onChange={setPurpose}
          disabled={submitting}
        />
        <FieldText
          label="Action — what's the smallest next step?"
          value={action}
          onChange={setAction}
          disabled={submitting}
        />
      </div>
      <SubmitFooter
        canSubmit={canSubmit && !submitting}
        submitting={submitting}
        onSubmit={handleSubmit}
        error={error}
      />
    </div>
  );
}

// --- Inquiry (Katie's 4 questions + turnaround) -----------------------------

function InquiryRoute({
  onDone,
  onBack,
}: {
  onDone: () => void;
  onBack: () => void;
}) {
  const save = useSaveOnDemand();
  const [thought, setThought] = useState("");
  const [q1, setQ1] = useState("");
  const [q2, setQ2] = useState("");
  const [q3, setQ3] = useState("");
  const [q4, setQ4] = useState("");
  const [turnaround, setTurnaround] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = thought.trim().length > 0;

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    const res = await save("inquiry", {
      thought,
      q1,
      q2,
      q3,
      q4,
      turnaround,
    });
    if (!res.ok) {
      setError(res.error ?? "save_failed");
      setSubmitting(false);
      return;
    }
    onDone();
  };

  return (
    <div>
      <BackHeader onBack={onBack} title="Stressful thought — sit with the 4 questions" />
      <div className="space-y-3">
        <FieldText
          label="What thought is most stressful right now?"
          value={thought}
          onChange={setThought}
          disabled={submitting}
        />
        <FieldText label="Is it true?" value={q1} onChange={setQ1} disabled={submitting} />
        <FieldText
          label="Can you absolutely know it's true?"
          value={q2}
          onChange={setQ2}
          disabled={submitting}
        />
        <FieldText
          label="How do you react when you believe that thought?"
          value={q3}
          onChange={setQ3}
          disabled={submitting}
        />
        <FieldText
          label="Who would you be without it?"
          value={q4}
          onChange={setQ4}
          disabled={submitting}
        />
        <FieldText
          label="Turnaround — what's the opposite of the thought? Is it as true or truer?"
          value={turnaround}
          onChange={setTurnaround}
          disabled={submitting}
        />
      </div>
      <SubmitFooter
        canSubmit={canSubmit && !submitting}
        submitting={submitting}
        onSubmit={handleSubmit}
        error={error}
      />
    </div>
  );
}

// --- Drained (energy audit) -------------------------------------------------

type AuditRow = { task: string; color: "red" | "yellow" | "green" | null };

function DrainedRoute({
  onDone,
  onBack,
}: {
  onDone: () => void;
  onBack: () => void;
}) {
  const save = useSaveOnDemand();
  const [rows, setRows] = useState<AuditRow[]>(() =>
    Array.from({ length: 5 }, () => ({ task: "", color: null })),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateRow = (i: number, patch: Partial<AuditRow>) => {
    setRows((prev) =>
      prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)),
    );
  };

  const filledRows = rows.filter((r) => r.task.trim().length > 0 && r.color);
  const reds = filledRows.filter((r) => r.color === "red");
  const yellows = filledRows.filter((r) => r.color === "yellow");
  const topConcerns = [...reds, ...yellows].slice(0, 2);

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    const res = await save("drained", {
      tasks: filledRows.map((r) => r.task),
      colors: filledRows.map((r) => r.color),
    });
    if (!res.ok) {
      setError(res.error ?? "save_failed");
      setSubmitting(false);
      return;
    }
    onDone();
  };

  return (
    <div>
      <BackHeader onBack={onBack} title="Energy audit — what's on your plate?" />
      <p className="text-xs text-gray-600">
        List 3-7 things on your plate this week. R/Y/G the energy each one
        carries. We&apos;ll surface the top 2 to look at first.
      </p>
      <div className="mt-4 space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              type="text"
              value={row.task}
              onChange={(e) => updateRow(i, { task: e.target.value })}
              placeholder={`Task ${i + 1}`}
              disabled={submitting}
              className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-black focus:border-black disabled:opacity-50"
            />
            <div className="flex items-center gap-1">
              {(["red", "yellow", "green"] as const).map((c) => {
                const active = row.color === c;
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => updateRow(i, { color: c })}
                    disabled={submitting}
                    aria-label={`${c} energy`}
                    title={c}
                    className={`h-6 w-6 rounded-full border transition disabled:opacity-50 ${
                      active
                        ? c === "red"
                          ? "bg-red-500 border-red-600"
                          : c === "yellow"
                            ? "bg-yellow-400 border-yellow-500"
                            : "bg-green-500 border-green-600"
                        : "bg-white border-gray-300 hover:border-gray-500"
                    }`}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {topConcerns.length > 0 && (
        <div className="mt-4 rounded-md bg-amber-50 border border-amber-200 p-3">
          <p className="text-xs font-medium text-amber-900">
            Top concerns to look at first
          </p>
          <ul className="mt-1 list-disc pl-5 text-xs text-amber-800">
            {topConcerns.map((c, i) => (
              <li key={i}>
                {c.task} <span className="uppercase">({c.color})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <SubmitFooter
        canSubmit={filledRows.length > 0 && !submitting}
        submitting={submitting}
        onSubmit={handleSubmit}
        error={error}
      />
    </div>
  );
}

// --- Chat fallback ----------------------------------------------------------

function ChatRoute({
  onDone,
  onBack,
}: {
  onDone: () => void;
  onBack: () => void;
}) {
  const router = useRouter();
  const save = useSaveOnDemand();
  const turn = useChatTurn();

  const [transcript, setTranscript] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finalising, setFinalising] = useState(false);

  const userTurns = transcript.filter((m) => m.role === "user").length;
  const atCap = userTurns >= CHAT_MAX_USER_TURNS;
  const canSend = !atCap && !thinking && input.trim().length > 0;

  const handleSend = async () => {
    if (!canSend) return;
    setError(null);
    const userMsg: ChatMessage = { role: "user", content: input.trim() };
    const nextTranscript = [...transcript, userMsg];
    setTranscript(nextTranscript);
    setInput("");
    setThinking(true);
    const res = await turn(nextTranscript);
    setThinking(false);
    if (!res.ok || !res.assistantMessage) {
      // Prefer the server-provided conversational message
      // (errorCodes: llm_quota / llm_timeout / llm_failed all carry one).
      // Special-case validation rejection too so the user knows the
      // transcript is the issue, not the model.
      const friendly =
        res.userMessage ??
        (res.error === "transcript_too_long"
          ? "this conversation has run its course — start fresh?"
          : "hmm, that didn't land. try rephrasing or hit reset.");
      setError(friendly);
      // Roll back the user message so they can retry without losing input.
      setTranscript(transcript);
      setInput(userMsg.content);
      return;
    }
    setTranscript([
      ...nextTranscript,
      { role: "assistant", content: res.assistantMessage },
    ]);
  };

  const persistAndClose = async () => {
    setFinalising(true);
    if (transcript.length > 0) {
      await save("other", { transcript });
    }
    setFinalising(false);
    onDone();
  };

  const handleTakeToDaily = async () => {
    setFinalising(true);
    if (transcript.length > 0) {
      await save("other", { transcript });
    }
    router.push("/daily");
  };

  return (
    <div>
      <BackHeader onBack={onBack} title="Open chat" />
      <p className="text-xs text-gray-600">
        Coach in your style. {CHAT_MAX_USER_TURNS} prompts max — Wingman is
        not built for deep coaching, so we keep it short.
      </p>

      <div className="mt-4 space-y-2 max-h-[40vh] overflow-y-auto">
        {transcript.length === 0 ? (
          <p className="text-xs text-gray-500 italic">
            Type below to start. {CHAT_MAX_USER_TURNS}-turn cap.
          </p>
        ) : (
          transcript.map((m, i) => (
            <div
              key={i}
              className={
                m.role === "user"
                  ? "rounded-md bg-gray-100 px-3 py-2 text-sm text-gray-900"
                  : "rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-800"
              }
            >
              {m.content}
            </div>
          ))
        )}
        {thinking && (
          <p className="text-xs italic text-gray-500">Thinking…</p>
        )}
      </div>

      {!atCap && (
        <div className="mt-4">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={thinking}
            placeholder={
              userTurns === 0
                ? "What's on your mind?"
                : `${CHAT_MAX_USER_TURNS - userTurns} prompts left`
            }
            rows={2}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black focus:border-black disabled:opacity-50"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-xs text-gray-500">
              {userTurns} of {CHAT_MAX_USER_TURNS} used
            </span>
            <button
              type="button"
              onClick={handleSend}
              disabled={!canSend}
              className="rounded-md bg-black text-white px-3 py-1.5 text-sm font-medium hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {thinking ? "Thinking…" : "Send"}
            </button>
          </div>
        </div>
      )}

      {atCap && (
        <div className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-3">
          <p className="text-sm text-gray-800">
            We&apos;ve covered ground. Want to take this to your daily ritual?
            Otherwise let&apos;s wrap.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={handleTakeToDaily}
              disabled={finalising}
              className="rounded-md bg-black text-white px-3 py-1.5 text-sm font-medium hover:bg-gray-800 disabled:opacity-50"
            >
              {finalising ? "Saving…" : "Take to daily ritual"}
            </button>
            <button
              type="button"
              onClick={persistAndClose}
              disabled={finalising}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
            >
              {finalising ? "Saving…" : "Done"}
            </button>
          </div>
        </div>
      )}

      {!atCap && transcript.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={persistAndClose}
            disabled={finalising || thinking}
            className="text-xs text-gray-600 hover:text-gray-900 underline disabled:opacity-50"
          >
            {finalising ? "Saving…" : "Done — save and close"}
          </button>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  );
}

// --- Shared form bits -------------------------------------------------------

function FieldText({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={2}
        className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-black focus:border-black disabled:opacity-50"
      />
    </div>
  );
}

function SubmitFooter({
  canSubmit,
  submitting,
  onSubmit,
  error,
}: {
  canSubmit: boolean;
  submitting: boolean;
  onSubmit: () => void;
  error: string | null;
}) {
  return (
    <div className="mt-4 flex items-center justify-end gap-3">
      {error && <span className="text-xs text-red-600">{error}</span>}
      <button
        type="button"
        onClick={onSubmit}
        disabled={!canSubmit}
        className="rounded-md bg-black text-white px-4 py-1.5 text-sm font-medium hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {submitting ? "Saving…" : "Save and close"}
      </button>
    </div>
  );
}
