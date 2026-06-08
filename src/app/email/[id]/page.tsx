import { EmailDetailView } from "./EmailDetailView";

export default async function EmailDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <EmailDetailView emailId={id} />;
}
