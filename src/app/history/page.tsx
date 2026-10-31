import type { Metadata } from "next";
import { PageShell } from "@/components/layout/PageShell";
import { requireUser } from "@/lib/auth";
import { HistoryDashboard } from "./HistoryDashboard";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Historical Weather Data",
  description:
    "Explore historical weather data for 265+ locations worldwide. Search temperature trends, precipitation records, and climate patterns.",
  keywords: [
    "historical weather data",
    "weather history",
    "temperature records",
    "climate data",
    "weather trends",
    "mukoko weather history",
  ],
  alternates: {
    canonical: `${SITE_URL}/history`,
  },
  openGraph: {
    title: "Historical Weather Data | mukoko weather",
    description:
      "Explore historical weather data for 265+ locations worldwide. Temperature trends, precipitation records, and climate patterns.",
    url: `${SITE_URL}/history`,
    type: "website",
    locale: "en",
    siteName: "mukoko weather",
  },
};

export default async function HistoryPage() {
  await requireUser("/history"); // redirects anon users to sign-in, returns here after
  return (
    <PageShell width="wide">
      <h1 className="elephant">Historical Weather Data</h1>
      <p className="gazelle mt-3">
        Explore recorded weather data worldwide. Select a location and time
        period to view temperature trends, precipitation, and climate patterns.
      </p>
      <HistoryDashboard />
    </PageShell>
  );
}
