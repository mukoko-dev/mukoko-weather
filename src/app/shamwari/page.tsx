import { Metadata } from "next";
import { notFound } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { requireUser } from "@/lib/auth";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { ShamwariPageClient } from "./ShamwariPageClient";

export const metadata: Metadata = {
  title: "Shamwari | mukoko weather",
  description:
    "Chat with Shamwari, your AI weather assistant. Get real-time weather insights, activity advice, and location comparisons across Africa.",
  alternates: {
    canonical: "https://weather.mukoko.com/shamwari",
  },
  openGraph: {
    title: "Shamwari | mukoko weather",
    description:
      "Chat with Shamwari, your AI weather assistant. Get real-time weather insights, activity advice, and location comparisons across Africa.",
  },
};

export default async function ShamwariPage() {
  // Paused as a standalone destination — see FLAGS.shamwari_chat.
  if (!isFeatureEnabled("shamwari_chat")) notFound();
  await requireUser("/shamwari"); // redirects anon users to sign-in, returns here after
  return (
    <>
      <Header />
      <ShamwariPageClient />
    </>
  );
}
