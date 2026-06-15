import type { Metadata } from "next";
import { Suspense } from "react";
import { ContactsView } from "./ContactsView";

export const metadata: Metadata = { title: "Contacts | Wingman" };

export default function ContactsPage() {
  // Suspense wrap follows the SettingsPage convention so Next.js 15 doesn't
  // bail out of prerender if the client view ever pulls useSearchParams (e.g.,
  // a future ?filter= deep-link).
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
      <ContactsView />
    </Suspense>
  );
}
