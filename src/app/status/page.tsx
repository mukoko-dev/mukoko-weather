import type { Metadata } from "next";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
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
      <Header />
      <main id="main-content" className="mx-auto max-w-3xl px-4 py-10 pb-24 sm:pb-10 sm:px-6 md:px-8">
        <h1 className="font-display text-3xl font-bold text-text-primary sm:text-4xl">
          System Status
        </h1>
        <p className="mt-2 text-text-secondary">
          Live health checks for mukoko weather services.
        </p>
        <StatusDashboard />
      </main>
      <Footer />
    </>
  );
}
