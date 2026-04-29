import { currentUser } from "@clerk/nextjs/server";
import { UserButton } from "@clerk/nextjs";

export default async function DashboardPage() {
  const user = await currentUser();
  const name =
    user?.firstName ??
    user?.fullName ??
    user?.emailAddresses[0]?.emailAddress ??
    "there";

  return (
    <main className="min-h-screen p-6">
      <header className="flex justify-between items-center max-w-4xl mx-auto">
        <h1 className="text-xl font-semibold">Project Wingman</h1>
        <UserButton />
      </header>
      <section className="max-w-4xl mx-auto mt-20 text-center">
        <h2 className="text-3xl font-semibold">Welcome, {name}.</h2>
        <p className="mt-3 text-gray-600">Your inbox triage starts here.</p>
      </section>
    </main>
  );
}
