import { EmailDetailView } from "./EmailDetailView";
import { Id } from "../../../../convex/_generated/dataModel";

export default async function EmailDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <EmailDetailView emailId={id as Id<"emails">} />;
}
