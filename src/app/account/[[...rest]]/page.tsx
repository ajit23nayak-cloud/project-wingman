"use client";

// Clerk's <UserProfile /> account portal mounted at /account, with a
// "Done — back to dashboard" button below it. The button hits
// /api/dashboard/clear-reauth-flag (strategy i for clearing
// gmail_reauth_needed) then navigates back to the dashboard.
//
// The [[...rest]] optional catch-all is required by Clerk for path-based
// routing — Clerk mounts sub-sections like /account/security and
// /account/connected-accounts under the same component.
//
// Why a button at all (vs. just a Link back to /dashboard): Clerk's
// reconnect flow is a separate browser interaction (popup or full-page
// redirect to Google). We have no programmatic signal of "reconnect
// succeeded" — the button is the user's signal. If they navigate back
// without clicking it, strategy (ii) (auto-clear on next successful
// gmail.* call) catches them on the next Refresh inbox click.

import { UserProfile } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useClearReauthFlag } from "@/lib/supabase/hooks";

export default function AccountPage() {
  const router = useRouter();
  const clearFlag = useClearReauthFlag();
  const [submitting, setSubmitting] = useState(false);

  async function handleDone() {
    setSubmitting(true);
    try {
      await clearFlag();
    } finally {
      router.push("/dashboard");
    }
  }

  return (
    <main className="min-h-screen p-6">
      <div className="max-w-3xl mx-auto">
        <Link href="/dashboard" className="text-sm text-gray-600 hover:text-gray-900">
          ← Back to dashboard
        </Link>
        <h1 className="mt-4 text-2xl font-semibold">Manage your account</h1>
        <p className="mt-2 text-sm text-gray-600">
          To reconnect Gmail: scroll to <strong>Connected accounts</strong>,
          remove Google, then re-add it. Once you&apos;re back here, click{" "}
          <strong>Done</strong> below.
        </p>
        <div className="mt-6">
          <UserProfile path="/account" routing="path" />
        </div>
        <div className="mt-8">
          <button
            type="button"
            onClick={handleDone}
            disabled={submitting}
            className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Done — back to dashboard"}
          </button>
        </div>
      </div>
    </main>
  );
}
