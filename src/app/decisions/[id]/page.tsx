import { Suspense } from "react";
import { DecisionDetailView } from "./DecisionDetailView";

export default async function DecisionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Suspense
      fallback={
        <main className="min-h-screen p-6">
          <p className="text-sm text-gray-500">Loading…</p>
        </main>
      }
    >
      <DecisionDetailView decisionId={id} />
    </Suspense>
  );
}
