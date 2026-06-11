import type { Metadata } from "next";
import { Suspense } from "react";
import { SettingsView } from "./SettingsView";

export const metadata: Metadata = {
  title: "Settings | Wingman",
  description: "Configure your Wingman account and privacy preferences.",
};

export default function SettingsPage() {
  // Suspense wrap is required because SettingsView calls useSearchParams()
  // for the Slack OAuth callback toast — Next.js 15 bails out of prerender
  // otherwise.
  return (
    <Suspense
      fallback={
        <main className="min-h-screen p-6">
          <div className="max-w-2xl mx-auto">
            <p className="text-gray-500 text-sm">Loading…</p>
          </div>
        </main>
      }
    >
      <SettingsView />
    </Suspense>
  );
}
