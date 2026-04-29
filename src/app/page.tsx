import { Show, SignInButton } from "@clerk/nextjs";
import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 text-center">
      <h1 className="text-5xl font-semibold tracking-tight">Project Wingman</h1>
      <p className="mt-4 text-lg text-gray-600 max-w-xl">
        AI Chief of Staff for founders. Coming soon.
      </p>
      <div className="mt-10">
        <Show when="signed-out">
          <SignInButton mode="modal">
            <button className="rounded-lg bg-black text-white px-6 py-3 text-sm font-medium hover:bg-gray-800 transition">
              Sign in
            </button>
          </SignInButton>
        </Show>
        <Show when="signed-in">
          <Link
            href="/dashboard"
            className="rounded-lg bg-black text-white px-6 py-3 text-sm font-medium hover:bg-gray-800 transition inline-block"
          >
            Go to dashboard
          </Link>
        </Show>
      </div>
    </main>
  );
}
