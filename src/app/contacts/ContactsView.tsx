"use client";

// Contacts list view. Filter chips drive useContacts(filter) which posts to
// GET /api/contacts?filter=...&limit=50. Each row links to /contacts/[id].
// Client-side text search filters the in-memory result set by display_name
// (v0: 50-row cap is fine for an in-memory filter; v1 moves this server-side
// when corpora cross thousands of contacts).

import { useMemo, useState } from "react";
import Link from "next/link";
import { useContacts, type ContactFilter } from "@/lib/supabase/hooks";

const FILTERS: { value: ContactFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "cadence-break", label: "Cadence break" },
  { value: "recent", label: "Recent" },
  { value: "archived", label: "Archived" },
];

export function ContactsView() {
  const [filter, setFilter] = useState<ContactFilter>("all");
  const [search, setSearch] = useState("");
  const { data: contacts, isLoading, error } = useContacts(filter);

  const filtered = useMemo(() => {
    if (!contacts) return [];
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => c.display_name.toLowerCase().includes(q));
  }, [contacts, search]);

  return (
    <main className="min-h-screen p-6">
      <div className="max-w-4xl mx-auto">
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-xl font-semibold">Contacts</h1>
          <Link
            href="/dashboard"
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            ← Dashboard
          </Link>
        </header>

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
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name"
            className="ml-auto rounded-md border border-gray-300 px-3 py-1 text-sm focus:border-gray-500 focus:outline-none"
          />
        </div>

        {error && (
          <p className="text-sm text-red-600">Could not load contacts.</p>
        )}
        {isLoading && !contacts && (
          <p className="text-sm text-gray-500">Loading…</p>
        )}
        {contacts && filtered.length === 0 && (
          <p className="text-sm text-gray-500">
            {search ? "No matches." : "No contacts in this view."}
          </p>
        )}

        <ul className="divide-y divide-gray-200 border-y border-gray-200">
          {filtered.map((c) => (
            <li key={c.id}>
              <Link
                href={`/contacts/${c.id}`}
                className="flex items-baseline justify-between gap-3 py-3 px-2 -mx-2 hover:bg-gray-50"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-gray-900">
                      {c.display_name}
                    </span>
                    {c.cadence_break_days !== null &&
                      c.cadence_break_days > 0 && (
                        <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] uppercase text-amber-800">
                          {Math.floor(c.cadence_break_days / 7)}w break
                        </span>
                      )}
                    {c.archived && (
                      <span className="shrink-0 rounded-full border border-gray-200 bg-gray-100 px-2 py-0.5 text-[10px] uppercase text-gray-600">
                        archived
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-gray-500">
                    {c.primary_email ?? c.primary_slack_user_id ?? "—"}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-xs font-medium text-gray-700">
                    {c.total_interactions_30d}
                  </div>
                  <div className="text-[10px] uppercase tracking-wide text-gray-400">
                    last 30d
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
