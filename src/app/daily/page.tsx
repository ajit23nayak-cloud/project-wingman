import type { Metadata } from "next";
import { DailyView } from "./DailyView";

export const metadata: Metadata = {
  title: "Sharpen the day | Wingman",
  description:
    "Morning and evening reflection in your style. Tracks your operating cadence.",
};

export default function DailyPage() {
  return <DailyView />;
}
