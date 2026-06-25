"use client";

// Page-mode wrapper around EmailDetailBody. The body component owns the
// fetch + draft-reply UX so the dashboard slide-in panel can reuse it
// (see src/components/dashboard/EmailSlidePanel.tsx). The page wrapper
// adds the back link + outer <main> shell.

import Link from "next/link";
import { EmailDetailBody } from "./EmailDetailBody";

export function EmailDetailView({ emailId }: { emailId: string }) {
  return (
    <main className="min-h-screen p-6">
      <div className="max-w-4xl mx-auto">
        <header className="flex items-center justify-between gap-3">
          <Link
            href="/dashboard"
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            ← Back to dashboard
          </Link>
        </header>
        <EmailDetailBody emailId={emailId} mode="page" />
      </div>
    </main>
  );
}
