import type { Metadata } from "next";
import { AssessmentView } from "./AssessmentView";

export const metadata: Metadata = {
  title: "Personalize Wingman | Wingman",
  description:
    "Six quick questions so Wingman's reflection and nudge surfaces match how you actually think.",
};

export default function AssessmentPage() {
  return <AssessmentView />;
}
