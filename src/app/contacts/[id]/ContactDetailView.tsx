"use client";

// Contact detail page. Shows the contact card (name, emails, aliases, last
// seen, total interactions, cadence) plus three editable manual fields
// (notes / tags / archived) and an interleaved cross-source recent
// interactions list. PATCH is debounced behind explicit Save buttons so the
// user can scratch-edit without firing one request per keystroke.

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  useContact,
  useUpdateContact,
  type RecentInteraction,
} from "@/lib/supabase/hooks";

export function ContactDetailView({ contactId }: { contactId: string }) {
  const { data, isLoading, error } = useContact(contactId);
  const updateContact = useUpdateContact();

  // Form drafts — initialized from server data on first load, then kept
  // independent so unsaved edits aren't blown away by background revalidation.
  const [notes, setNotes] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [archived, setArchived] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState<null | "notes" | "tags" | "archive">(
    null,
  );
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!data || hydrated) return;
    setNotes(data.contact.manual_notes ?? "");
    setTagsText((data.contact.manual_tags ?? []).join(", "));
    setArchived(data.contact.archived);
    setHydrated(true);
  }, [data, hydrated]);

  if (isLoading && !data) {
    return (
      <main className="min-h-screen p-6">
        <p className="text-sm text-gray-500">Loading…</p>
      </main>
    );
  }
  if (error || !data) {
    return (
      <main className="min-h-screen p-6">
        <Link
          href="/contacts"
          className="text-sm text-gray-600 hover:text-gray-900"
        >
          ← Contacts
        </Link>
        <p className="mt-4 text-sm text-red-600">Could not load contact.</p>
      </main>
    );
  }

  const c = data.contact;

  const saveNotes = async () => {
    setSaving("notes");
    setSaveError(null);
    const r = await updateContact(c.id, { manual_notes: notes });
    if (!r.ok) setSaveError(r.error ?? "save_failed");
    setSaving(null);
  };
  const saveTags = async () => {
    setSaving("tags");
    setSaveError(null);
    const parsed = tagsText
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const r = await updateContact(c.id, { manual_tags: parsed });
    if (!r.ok) setSaveError(r.error ?? "save_failed");
    setSaving(null);
  };
  const toggleArchived = async () => {
    setSaving("archive");
    setSaveError(null);
    const next = !archived;
    const r = await updateContact(c.id, { archived: next });
    if (r.ok) setArchived(next);
    else setSaveError(r.error ?? "save_failed");
    setSaving(null);
  };

  return (
    <main className="min-h-screen p-6">
      <div className="max-w-4xl mx-auto">
        <Link
          href="/contacts"
          className="text-sm text-gray-600 hover:text-gray-900"
        >
          ← Contacts
        </Link>

        {/* Identity + telemetry card */}
        <header className="mt-4 rounded-lg border border-gray-200 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-semibold text-gray-900">
                {c.display_name}
              </h1>
              <div className="mt-1 text-xs text-gray-600">
                {c.primary_email && <span>{c.primary_email}</span>}
                {c.primary_email && c.primary_slack_user_id && <span> · </span>}
                {c.primary_slack_user_id && (
                  <span>Slack: {c.primary_slack_user_id}</span>
                )}
              </div>
              {c.aliases && c.aliases.length > 0 && (
                <div className="mt-1 text-xs text-gray-500">
                  aka {c.aliases.join(", ")}
                </div>
              )}
            </div>
            {c.cadence_break_days !== null && c.cadence_break_days > 0 && (
              <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
                {Math.floor(c.cadence_break_days / 7)} weeks since contact
              </span>
            )}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
            <Stat label="Last seen" value={formatDate(c.last_seen_at)} />
            <Stat label="Lifetime" value={String(c.total_interactions_lifetime)} />
            <Stat label="Last 30d" value={String(c.total_interactions_30d)} />
          </div>
        </header>

        {/* Manual fields */}
        <section className="mt-6 rounded-lg border border-gray-200 p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-900">Notes</h2>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder="Private notes only you see."
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={saveNotes}
              disabled={saving === "notes"}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium hover:bg-gray-50 disabled:opacity-50"
            >
              {saving === "notes" ? "Saving…" : "Save notes"}
            </button>
          </div>

          <h2 className="mt-6 mb-3 text-sm font-semibold text-gray-900">
            Tags
          </h2>
          <input
            type="text"
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder="comma, separated, tags"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={saveTags}
              disabled={saving === "tags"}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium hover:bg-gray-50 disabled:opacity-50"
            >
              {saving === "tags" ? "Saving…" : "Save tags"}
            </button>
          </div>

          <div className="mt-6 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-gray-900">
                {archived ? "Archived" : "Active"}
              </p>
              <p className="text-xs text-gray-500">
                {archived
                  ? "Hidden from cadence flags and the default contacts list."
                  : "Visible in all contact views."}
              </p>
            </div>
            <button
              type="button"
              onClick={toggleArchived}
              disabled={saving === "archive"}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium hover:bg-gray-50 disabled:opacity-50"
            >
              {saving === "archive"
                ? "Saving…"
                : archived
                  ? "Unarchive"
                  : "Archive"}
            </button>
          </div>

          {saveError && (
            <p className="mt-3 text-xs text-red-600">
              Could not save: {saveError}
            </p>
          )}
        </section>

        {/* Cross-source recent interactions */}
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-semibold text-gray-900">
            Recent interactions
          </h2>
          {data.recent_interactions.length === 0 ? (
            <p className="text-sm text-gray-500">
              No interactions in the last 30 days.
            </p>
          ) : (
            <ul className="space-y-1">
              {data.recent_interactions.map((it) => (
                <InteractionRow
                  key={`${it.kind}-${it.id}`}
                  interaction={it}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-100 bg-gray-50 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-gray-500">
        {label}
      </div>
      <div className="mt-0.5 text-sm font-medium text-gray-900">{value}</div>
    </div>
  );
}

// Single interaction row. Source-coded color + glyph so a glance distinguishes
// email vs Slack vs calendar without the user having to read the kind label.
function InteractionRow({ interaction }: { interaction: RecentInteraction }) {
  const time =
    interaction.kind === "calendar"
      ? formatDate(interaction.start_at)
      : formatEpochMs(interaction.received_at);

  if (interaction.kind === "email") {
    return (
      <li>
        <Link
          href={interaction.link}
          className="flex items-center gap-3 rounded-md border border-gray-100 bg-white px-3 py-2 hover:border-gray-300"
        >
          <span className="shrink-0 rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] uppercase text-blue-700">
            email
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-gray-900">
              {interaction.subject || "(no subject)"}
            </div>
            {interaction.snippet && (
              <div className="mt-0.5 truncate text-xs text-gray-600">
                {interaction.snippet}
              </div>
            )}
          </div>
          <span className="shrink-0 text-xs text-gray-500">{time}</span>
        </Link>
      </li>
    );
  }
  if (interaction.kind === "slack") {
    return (
      <li>
        <div className="flex items-center gap-3 rounded-md border border-gray-100 bg-white px-3 py-2">
          <span className="shrink-0 rounded border border-purple-200 bg-purple-50 px-1.5 py-0.5 text-[10px] uppercase text-purple-700">
            slack
          </span>
          <p className="min-w-0 flex-1 truncate text-sm text-gray-900">
            {interaction.text}
          </p>
          <span className="shrink-0 text-xs text-gray-500">{time}</span>
        </div>
      </li>
    );
  }
  // calendar
  return (
    <li>
      <div className="flex items-center gap-3 rounded-md border border-gray-100 bg-white px-3 py-2">
        <span className="shrink-0 rounded border border-green-200 bg-green-50 px-1.5 py-0.5 text-[10px] uppercase text-green-700">
          meeting
        </span>
        <p className="min-w-0 flex-1 truncate text-sm text-gray-900">
          {interaction.title}
        </p>
        <span className="shrink-0 text-xs text-gray-500">{time}</span>
      </div>
    </li>
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

function formatEpochMs(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
