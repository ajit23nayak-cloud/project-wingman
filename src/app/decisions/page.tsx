import type { Metadata } from "next";
import { Suspense } from "react";
import { DecisionsView } from "./DecisionsView";

export const metadata: Metadata = { title: "Decisions | Wingman" };

export default function DecisionsPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen p-6">
          <div className="max-w-4xl mx-auto">
            <p className="text-sm text-gray-500">Loading…</p>
          </div>
        </main>
      }
    >
      <DecisionsView />
    </Suspense>
  );
}
