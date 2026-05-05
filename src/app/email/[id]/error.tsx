"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function EmailDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[email-detail] render error", error);
  }, [error]);

  return (
    <main className="min-h-screen p-6">
      <div className="max-w-4xl mx-auto">
        <Link
          href="/dashboard"
          className="text-sm text-gray-600 hover:text-gray-900"
        >
          ← Back to dashboard
        </Link>
        <p className="mt-6 text-gray-700">
          We couldn&apos;t load this email. The link may be invalid or the
          email no longer exists.
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-4 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
