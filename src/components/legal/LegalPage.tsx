// Shared layout for /privacy and /terms. Server component (no client-side
// interactivity) so the wrapping pages can export `metadata` for SEO/OAuth
// consent screen discoverability. Body content is passed as children — the
// two pages remain thin JSX shells over their respective markdown source.

import Link from "next/link";
import { ReactNode } from "react";
import { WingmanLogo } from "@/components/WingmanLogo";

export function LegalPage({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <nav className="border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-6 py-5 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <WingmanLogo size={32} />
            <span className="text-xl font-medium">
              Wing<span className="italic">man</span>
            </span>
          </Link>
          <Link
            href="/"
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            ← Back to home
          </Link>
        </div>
      </nav>

      <main className="max-w-3xl mx-auto px-6 py-12">
        <article className="text-[15px] leading-relaxed text-gray-800 space-y-5 [&_h1]:text-3xl [&_h1]:font-semibold [&_h1]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:mt-10 [&_h2]:mb-3 [&_p]:leading-relaxed [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:space-y-1.5 [&_li]:leading-relaxed [&_strong]:font-semibold [&_code]:bg-gray-100 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[13px] [&_code]:font-mono">
          {children}
        </article>
      </main>

      <footer className="border-t border-gray-200 mt-12">
        <div className="max-w-3xl mx-auto px-6 py-6 text-xs text-gray-500 flex items-center justify-between">
          <div>© {new Date().getFullYear()} Wingman · Built in Bangalore.</div>
          <div className="flex gap-4">
            <Link href="/privacy" className="hover:text-gray-700">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-gray-700">
              Terms
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
