import { Metadata } from "next";
import { Header } from "@/components/layout/Header";
import { requireUser } from "@/lib/auth";
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
  await requireUser(); // redirects to AuthKit sign-in if not signed in
  return (
    <>
      <Header />
      <ShamwariPageClient />
    </>
  );
}
