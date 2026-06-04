"use client";

import { useState } from "react";
import { useUser } from "@clerk/nextjs";
import useSWR from "swr";

type WaitlistApplication = {
  id: string;
  email: string;
  company: string;
  overload_response: string;
  status: "pending" | "invited" | "rejected";
  created_at: number;
  invited_at: number | null;
};
type WaitlistCounts = {
  pending: number;
  invited: number;
  rejected: number;
  total: number;
};
type AdminListResponse = {
  applications: WaitlistApplication[];
  counts: WaitlistCounts;
};

function formatDateTime(ms: number | undefined | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n) + "…";
}

function StatusChip({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: "bg-gray-200 text-gray-800",
    invited: "bg-green-200 text-green-900",
    rejected: "bg-red-200 text-red-900",
  };
  const cls = colors[status] ?? "bg-gray-200 text-gray-800";
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {status}
    </span>
  );
}

export function WaitlistAdminView() {
  const { isLoaded, isSignedIn } = useUser();
  const authReady = isLoaded && isSignedIn;
  const { data, error, mutate } = useSWR<AdminListResponse>(
    authReady ? "/api/admin/waitlist" : null,
    async (url: string) => {
      const res = await fetch(url);
      if (res.status === 401 || res.status === 403) {
        return {
          applications: [],
          counts: { pending: 0, invited: 0, rejected: 0, total: 0 },
        };
      }
      if (!res.ok) throw new Error(`admin_waitlist_${res.status}`);
      return res.json();
    },
  );
  const applications = data?.applications;
  const counts = data?.counts;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pendingMark, setPendingMark] = useState<Record<string, boolean>>({});

  if (!isLoaded) {
    return <main className="min-h-screen p-6" />;
  }
  if (!isSignedIn) {
    return (
      <main className="min-h-screen p-6">
        <p>Not found.</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="min-h-screen p-6">
        <h1 className="text-2xl font-semibold">Waitlist — admin</h1>
        <p className="text-sm text-red-600 mt-4">
          Could not load applications. Refresh.
        </p>
      </main>
    );
  }

  if (applications === undefined || counts === undefined) {
    return <main className="min-h-screen p-6" />;
  }

  if (applications.length === 0 && counts.total === 0) {
    return (
      <main className="min-h-screen p-6">
        <h1 className="text-2xl font-semibold">Waitlist — admin</h1>
        <p className="mt-4 text-sm text-gray-600">No applications yet.</p>
      </main>
    );
  }

  async function handleMarkInvited(id: string) {
    setPendingMark((prev) => ({ ...prev, [id]: true }));
    try {
      const res = await fetch("/api/admin/waitlist/mark-invited", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        await mutate();
      }
    } finally {
      setPendingMark((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }

  return (
    <main className="min-h-screen p-6">
      <h1 className="text-2xl font-semibold">Waitlist — admin</h1>
      <p className="mt-2 text-sm text-gray-600">
        Admin-only. Most recent first.
      </p>

      <section className="mt-6">
        <table className="w-full text-sm border-collapse">
          <thead className="text-left text-gray-500">
            <tr className="border-b border-gray-300">
              <th className="py-2 pr-3 font-medium">Submitted</th>
              <th className="py-2 pr-3 font-medium">Email</th>
              <th className="py-2 pr-3 font-medium">Company</th>
              <th className="py-2 pr-3 font-medium">Overload response</th>
              <th className="py-2 pr-3 font-medium">Status</th>
              <th className="py-2 pr-3 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {applications.map((row) => {
              const isOpen = !!expanded[row.id];
              return (
                <Row
                  key={row.id}
                  row={row}
                  isOpen={isOpen}
                  isPending={!!pendingMark[row.id]}
                  onToggle={() =>
                    setExpanded((prev) => ({
                      ...prev,
                      [row.id]: !prev[row.id],
                    }))
                  }
                  onMarkInvited={() => handleMarkInvited(row.id)}
                />
              );
            })}
          </tbody>
        </table>
      </section>

      <p className="mt-6 text-sm text-gray-600">
        Showing {applications.length} applications. {counts.invited} invited.{" "}
        {counts.pending} pending.
      </p>
    </main>
  );
}

function Row({
  row,
  isOpen,
  isPending,
  onToggle,
  onMarkInvited,
}: {
  row: WaitlistApplication;
  isOpen: boolean;
  isPending: boolean;
  onToggle: () => void;
  onMarkInvited: () => void;
}) {
  return (
    <>
      <tr
        className="border-b border-gray-200 align-top cursor-pointer hover:bg-gray-50"
        onClick={onToggle}
      >
        <td className="py-2 pr-3 whitespace-nowrap text-gray-700">
          {formatDateTime(row.created_at)}
        </td>
        <td className="py-2 pr-3">{row.email}</td>
        <td className="py-2 pr-3">{row.company}</td>
        <td className="py-2 pr-3">{truncate(row.overload_response, 80)}</td>
        <td className="py-2 pr-3">
          <StatusChip status={row.status} />
        </td>
        <td
          className="py-2 pr-3"
          onClick={(e) => e.stopPropagation()}
        >
          {row.status === "pending" && (
            <button
              type="button"
              onClick={onMarkInvited}
              disabled={isPending}
              className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 disabled:opacity-50"
            >
              {isPending ? "Saving…" : "Mark invited"}
            </button>
          )}
        </td>
      </tr>
      {isOpen && (
        <tr className="border-b border-gray-200 bg-gray-50">
          <td colSpan={6} className="py-3 px-3">
            <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">
              Full overload response
            </div>
            <p className="text-sm whitespace-pre-wrap text-gray-800">
              {row.overload_response}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}
