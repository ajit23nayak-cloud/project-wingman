"use client";

// OKR Tracker dashboard surface — Phase 4 + dashboard redesign (08:30 + 08:55
// UTC 2026-06-18 spec).
//
// Renders Notion pages classified as OKR docs (is_okr_page=true), sorted by
// last_edited_at desc. Each row uses the shared DashboardRow primitive in its
// collapsed state, then expands inline (Lock 2 of 08:55: OKR is the visual
// exception — expansion preserved). The "Open in Notion ↗" link moves INSIDE
// the expanded view per Lock 3 of 08:55 (clean collapsed row).
//
// Hidden when empty per the DecisionsPostmortemDueView pattern.
//
// Reads okr_structured jsonb from notion_pages — extracted at classification
// time by src/lib/prompts/okrExtract.ts. When extraction failed (detect=true
// but Gemini returned malformed JSON), the dotLabel falls back to "OKR
// detected, not parsed" and the expanded section is suppressed.

import { useState } from "react";
import {
  useNotionIntegration,
  useOKRs,
  type OKRPageRow,
} from "@/lib/supabase/hooks";
import {
  DashboardRow,
  DashboardRowList,
  DashboardSection,
  DashboardSectionHeader,
  dotForKrRollup,
  formatRelativeAge,
} from "./_primitives";

export function OKRTrackerView() {
  const { data: notionIntegration } = useNotionIntegration();
  const enabled = notionIntegration?.status === "active";
  const { data: okrs, isLoading } = useOKRs(enabled);

  // Silent when not connected, loading, or no OKR pages found.
  if (!enabled) return null;
  if (isLoading) return null;
  if (!okrs || okrs.length === 0) return null;

  return (
    <DashboardSection>
      <DashboardSectionHeader title="okrs" count={`${okrs.length} active`} />
      <DashboardRowList>
        {okrs.map((page) => (
          <OKRCard key={page.id} page={page} />
        ))}
      </DashboardRowList>
    </DashboardSection>
  );
}

function OKRCard({ page }: { page: OKRPageRow }) {
  const [expanded, setExpanded] = useState(false);
  const structured = page.okr_structured;
  const objectives = structured?.objectives ?? [];
  const krCount = objectives.reduce(
    (sum, o) => sum + (o.key_results?.length ?? 0),
    0,
  );
  const hasStructure = objectives.length > 0;
  // Collect KR confidences for the dot rollup. Rule (per primitive
  // dotForKrRollup): red if any KR red, else amber if any yellow, else green
  // if any green, else grey. Documented inline per spec gap callout.
  const krConfidences = objectives.flatMap((o) =>
    (o.key_results ?? []).map((kr) => kr.confidence),
  );

  // last_edited_at is an ISO string from supabase — wrap in Date for the
  // epoch-ms input formatRelativeAge expects.
  const timeStr = formatRelativeAge(new Date(page.last_edited_at).getTime());

  return (
    <div>
      <DashboardRow
        dot={dotForKrRollup(krConfidences)}
        dotLabel={
          hasStructure
            ? `${objectives.length} objectives, ${krCount} key results`
            : "OKR detected, not parsed"
        }
        time={timeStr}
        title={page.title}
        badge="okr"
        hint={expanded ? "collapse" : "open"}
        onClick={() => setExpanded((v) => !v)}
      />
      {expanded && hasStructure && (
        <div className="border-t-[0.5px] border-gray-100 bg-gray-50/50 px-3 py-2 space-y-3">
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
          {page.url && (
            <a
              href={page.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-[11px] font-mono lowercase text-gray-500 hover:text-gray-900"
            >
              open in notion ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}
