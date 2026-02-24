import type { Metadata } from "next";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { HistoryDashboard } from "./HistoryDashboard";

const BASE_URL = "https://weather.mukoko.com";

export const metadata: Metadata = {
  title: "Historical Weather Data",
  description:
    "Explore historical weather data for 90+ Zimbabwe locations. Search temperature trends, precipitation records, and climate patterns across Harare, Bulawayo, Mutare, and more.",
  keywords: [
    "Zimbabwe historical weather",
    "Zimbabwe weather history",
    "Zimbabwe temperature records",
    "Harare weather history",
    "Zimbabwe climate data",
    "mukoko weather history",
  ],
  alternates: {
    canonical: `${BASE_URL}/history`,
  },
  openGraph: {
    title: "Historical Weather Data | mukoko weather",
    description:
      "Explore historical weather data for 90+ Zimbabwe locations. Temperature trends, precipitation records, and climate patterns.",
    url: `${BASE_URL}/history`,
    type: "website",
    locale: "en_ZW",
    siteName: "mukoko weather",
  },
};

export default function HistoryPage() {
  return (
    <>
      <Header />
      <main id="main-content" className="animate-fade-in mx-auto max-w-5xl px-4 py-8 pb-24 sm:pb-8 sm:px-6 md:px-8">
        <h1 className="font-display text-3xl font-bold text-text-primary sm:text-4xl">
          Historical Weather Data
        </h1>
        <p className="mt-3 text-text-secondary">
          Explore recorded weather data across Zimbabwe. Select a location and time period to view
          temperature trends, precipitation, and climate patterns.
        </p>
        <HistoryDashboard />
      </main>
      <Footer />
    </>
  );
}
