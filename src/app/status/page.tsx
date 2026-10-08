import type { Metadata } from "next";
import { PageShell } from "@/components/layout/PageShell";
import { StatusDashboard } from "./StatusDashboard";

export const metadata: Metadata = {
  title: "System Status",
  description:
    "Live health checks for mukoko weather services — weather APIs, AI summaries, database, and caching status.",
  alternates: {
    canonical: "https://weather.mukoko.com/status",
  },
};

export default function StatusPage() {
  return (
    <>
      <PageShell>
        <h1 className="elephant">System Status</h1>
        <p className="mt-2 text-text-secondary">
          Live health checks for mukoko weather services.
        </p>
        <StatusDashboard />
      </PageShell>
    </>
  );
}
