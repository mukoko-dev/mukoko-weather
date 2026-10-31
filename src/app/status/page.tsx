import type { Metadata } from "next";
import { PageShell } from "@/components/layout/PageShell";
import { PageHeader } from "@/components/layout/PageHeader";
import { SITE_URL } from "@/lib/site";
import { StatusDashboard } from "./StatusDashboard";

export const metadata: Metadata = {
  title: "System Status",
  description:
    "Live health checks for mukoko weather services — weather APIs, AI summaries, database, and caching status.",
  alternates: {
    canonical: `${SITE_URL}/status`,
  },
};

export default function StatusPage() {
  return (
    <>
      <PageShell>
        <PageHeader
          title="System Status"
          intro="Live health checks for mukoko weather services."
        />
        <StatusDashboard />
      </PageShell>
    </>
  );
}
