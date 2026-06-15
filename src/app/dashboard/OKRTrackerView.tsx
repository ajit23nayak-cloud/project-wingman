"use client";

// OKR Tracker dashboard surface — Phase 4.
//
// Renders Notion pages classified as OKR docs (is_okr_page=true), sorted
// by last_edited_at desc. Each card shows the page title + parsed
// quarter + key-results count, with click-to-expand for the full
// Objective → KR structure. Hidden when empty per the
// DecisionsPostmortemDueView pattern.
//
// Reads okr_structured jsonb from notion_pages — extracted at
// classification time by src/lib/prompts/okrExtract.ts. When extraction
// failed (detect=true but Gemini returned malformed JSON), the card
// shows a "detected but not parsed" placeholder instead of crashing.

import { useState } from "react";
import {
  useNotionIntegration,
  useOKRs,
  type OKRPageRow,
  type OKRObjective,
} from "@/lib/supabase/hooks";

export function OKRTrackerView() {
  const { data: notionIntegration } = useNotionIntegration();
  const enabled = notionIntegration?.status === "active";
  const { data: okrs, isLoading } = useOKRs(enabled);

  // Silent when not connected, loading, or no OKR pages found.
  if (!enabled) return null;
  if (isLoading) return null;
  if (!okrs || okrs.length === 0) return null;

  return (
    <section className="mb-6">
      <h2 className="text-base font-semibold text-gray-900 mb-2">OKRs</h2>
      <div className="space-y-1">
        {okrs.map((page) => (
          <OKRCard key={page.id} page={page} />
        ))}
      </div>
    </section>
  );
}

function OKRCard({ page }: { page: OKRPageRow }) {
  const [expanded, setExpanded] = useState(false);
  const structured = page.okr_structured;
  const objectives: OKRObjective[] = structured?.objectives ?? [];
  const krCount = objectives.reduce(
    (sum, o) => sum + (o.key_results?.length ?? 0),
    0,
  );
  const quarter = structured?.quarter ?? null;
  const hasStructure = objectives.length > 0;

  return (
    <div className="rounded-md border border-indigo-100 bg-indigo-50/40 hover:border-indigo-300">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left"
        aria-expanded={expanded}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="truncate text-sm font-medium text-gray-900">
              {page.title}
            </span>
            {quarter && (
              <span className="shrink-0 rounded-full bg-indigo-200 px-2 py-0.5 text-[10px] uppercase tracking-wide text-indigo-900">
                {quarter}
              </span>
            )}
            {hasStructure ? (
              <span className="shrink-0 text-xs text-indigo-700">
                {objectives.length} obj · {krCount} KR
              </span>
            ) : (
              <span className="shrink-0 text-xs text-amber-700">
                detected, not parsed
              </span>
            )}
          </div>
        </div>
        {page.url && (
          <a
            href={page.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 text-xs text-indigo-700 hover:underline"
          >
            Open ↗
          </a>
        )}
      </button>
      {expanded && hasStructure && (
        <div className="border-t border-indigo-100 px-3 py-2 space-y-3">
          {objectives.map((obj, oi) => (
            <div key={oi} className="text-xs">
              <p className="font-medium text-gray-900">{obj.text}</p>
              {obj.key_results.length > 0 && (
                <ul className="mt-1 ml-3 list-disc space-y-0.5 text-gray-700">
                  {obj.key_results.map((kr, ki) => (
                    <li key={ki} className="flex items-baseline gap-2">
                      <span className="flex-1">{kr.text}</span>
                      {kr.progress && (
                        <span className="text-gray-500">{kr.progress}</span>
                      )}
                      {kr.confidence && (
                        <span
                          className={
                            kr.confidence === "green"
                              ? "text-green-700"
                              : kr.confidence === "yellow"
                                ? "text-amber-700"
                                : "text-red-700"
                          }
                        >
                          ●
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
