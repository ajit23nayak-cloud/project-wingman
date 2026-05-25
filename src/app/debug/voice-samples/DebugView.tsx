"use client";

import { useUser } from "@clerk/nextjs";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../convex/_generated/api";
import { Doc } from "../../../../convex/_generated/dataModel";

type DraftRow = FunctionReturnType<
  typeof api.inbox.listRecentDraftsForAdmin
>[number];

type Segment =
  | "cold_outreach"
  | "internal_team"
  | "investor_ish"
  | "casual_peer";

const SEGMENTS: { key: Segment; label: string }[] = [
  { key: "cold_outreach", label: "Cold outreach" },
  { key: "internal_team", label: "Internal team" },
  { key: "investor_ish", label: "Investor-ish" },
  { key: "casual_peer", label: "Casual peer" },
];

function formatDate(ms: number | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n) + "…";
}

function shortId(id: string): string {
  return id.length <= 6 ? id : id.slice(-6);
}

export function DebugView() {
  const { isLoaded, isSignedIn } = useUser();
  // Gate Convex queries on Clerk auth so unauthenticated visitors never fire
  // them. Server-side admin check still runs inside the queries.
  const authReady = isLoaded && isSignedIn;
  const samples = useQuery(
    api.voiceSamples.listAllForAdmin,
    authReady ? {} : "skip",
  );
  const drafts = useQuery(
    api.inbox.listRecentDraftsForAdmin,
    authReady ? {} : "skip",
  );

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

  // While Convex resolves, render nothing rather than flashing "Not found."
  if (samples === undefined || drafts === undefined) {
    return <main className="min-h-screen p-6" />;
  }

  return <DebugBody samples={samples} drafts={drafts} />;
}

function DebugBody({
  samples,
  drafts,
}: {
  samples: Doc<"voiceSamples">[];
  drafts: DraftRow[];
}) {
  // Admin gate is server-side: non-admins get [] from both. Collapse to a
  // single line that doubles as 404 and empty-state.
  if (samples.length === 0 && drafts.length === 0) {
    return (
      <main className="min-h-screen p-6">
        <p>Not found.</p>
      </main>
    );
  }

  const byId = new Map<string, Doc<"voiceSamples">>();
  for (const s of samples) byId.set(s._id, s);

  const bySegment: Record<Segment, Doc<"voiceSamples">[]> = {
    cold_outreach: [],
    internal_team: [],
    investor_ish: [],
    casual_peer: [],
  };
  for (const s of samples) bySegment[s.segment].push(s);
  for (const seg of SEGMENTS) {
    bySegment[seg.key].sort((a, b) => b.sentAt - a.sentAt);
  }

  return (
    <main className="min-h-screen p-6">
      <h1 className="text-2xl font-semibold">Voice samples — debug</h1>
      <p className="mt-2 text-sm text-gray-600">
        Admin-only. Read-only. Cross-references voice corpus rows with recent
        draft provenance.
      </p>

      <section className="mt-8">
        <h2 className="text-lg font-semibold mb-3">Distribution by segment</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {SEGMENTS.map((seg) => (
            <div
              key={seg.key}
              className="rounded-lg border border-gray-200 p-4"
            >
              <div className="text-xs text-gray-500 uppercase tracking-wide">
                {seg.label}
              </div>
              <div className="text-2xl font-semibold mt-1">
                {bySegment[seg.key].length}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 space-y-3">
          {SEGMENTS.map((seg) => {
            const rows = bySegment[seg.key];
            return (
              <details
                key={seg.key}
                className="rounded-lg border border-gray-200"
              >
                <summary className="cursor-pointer px-4 py-2 text-sm font-medium select-none">
                  {seg.label} ({rows.length})
                </summary>
                <div className="px-4 py-3 overflow-x-auto">
                  {rows.length === 0 ? (
                    <p className="text-sm text-gray-500">No rows.</p>
                  ) : (
                    <table className="w-full text-xs">
                      <thead className="text-left text-gray-500">
                        <tr>
                          <th className="py-1 pr-3 font-medium">Subject</th>
                          <th className="py-1 pr-3 font-medium">Snippet</th>
                          <th className="py-1 pr-3 font-medium">Reply type</th>
                          <th className="py-1 pr-3 font-medium">Confidence</th>
                          <th className="py-1 pr-3 font-medium">Sent</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr
                            key={r._id}
                            className="border-t border-gray-100 align-top"
                          >
                            <td className="py-1 pr-3">
                              <div className="max-w-[16rem] truncate">
                                {r.subject || "(no subject)"}
                              </div>
                            </td>
                            <td className="py-1 pr-3">
                              {truncate(r.snippet, 100)}
                            </td>
                            <td className="py-1 pr-3">{r.replyType}</td>
                            <td className="py-1 pr-3">
                              {r.segmentConfidence.toFixed(2)}
                            </td>
                            <td className="py-1 pr-3 whitespace-nowrap">
                              {formatDate(r.sentAt)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold mb-3">
          Last 10 drafts (most recent first)
        </h2>
        {drafts.length === 0 ? (
          <p className="text-sm text-gray-500">No drafts yet.</p>
        ) : (
          <div className="space-y-2">
            {drafts.map((d) => {
              const ids = d.snippetIndicesUsed ?? [];
              return (
                <details
                  key={d._id}
                  className="rounded-lg border border-gray-200"
                >
                  <summary className="cursor-pointer px-4 py-2 text-sm select-none">
                    <div className="grid grid-cols-12 gap-3">
                      <div className="col-span-5 truncate font-medium">
                        {d.subject || "(no subject)"}
                      </div>
                      <div className="col-span-2 text-gray-600 whitespace-nowrap">
                        {formatDate(d.draftReplyGeneratedAt)}
                      </div>
                      <div className="col-span-2 text-gray-600">
                        {d.segmentUsed ?? "—"}
                      </div>
                      <div className="col-span-3 text-gray-500 truncate">
                        {ids.length} sample{ids.length === 1 ? "" : "s"}
                        {ids.length > 0 && (
                          <>: {ids.map((i) => shortId(i)).join(", ")}</>
                        )}
                      </div>
                    </div>
                  </summary>
                  <div className="px-4 py-3 space-y-3 border-t border-gray-100">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">
                        Draft reply
                      </div>
                      <pre className="text-xs whitespace-pre-wrap font-mono bg-gray-50 p-2 rounded border border-gray-200">
                        {d.draftReply ?? "(none)"}
                      </pre>
                    </div>
                    {ids.length > 0 && (
                      <div>
                        <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">
                          Sample snippets used
                        </div>
                        <ul className="text-xs space-y-1">
                          {ids.map((id) => {
                            const row = byId.get(id);
                            return (
                              <li
                                key={id}
                                className="border border-gray-100 rounded p-2"
                              >
                                <div className="text-gray-500">
                                  {shortId(id)}
                                  {row ? ` · ${row.segment} · ${row.replyType}` : " · (row not in current corpus)"}
                                </div>
                                {row && (
                                  <div className="mt-1">
                                    {truncate(row.snippet, 200)}
                                  </div>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
