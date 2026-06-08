import type { Metadata } from "next";
import { SettingsView } from "./SettingsView";

export const metadata: Metadata = {
  title: "Settings | Wingman",
  description: "Configure your Wingman account and privacy preferences.",
};

export default function SettingsPage() {
  return <SettingsView />;
}
