import { Suspense } from "react";
import { ContactDetailView } from "./ContactDetailView";

export default async function ContactDetailPage({
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
      <ContactDetailView contactId={id} />
    </Suspense>
  );
}
