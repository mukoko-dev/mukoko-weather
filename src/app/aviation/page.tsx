import type { Metadata } from "next";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { requireUser } from "@/lib/auth";
import { AviationPlanner } from "./AviationPlanner";

const BASE_URL = "https://weather.mukoko.com";

export const metadata: Metadata = {
  title: "Aviation Weather Briefing | mukoko weather",
  description: "Pre-flight weather briefing for pilots. METAR, TAF, flight conditions, and PDF trip plan generation for African and global airports.",
  alternates: { canonical: `${BASE_URL}/aviation` },
  openGraph: {
    title: "Aviation Weather Briefing | mukoko weather",
    description: "Pre-flight METAR, TAF, and PDF trip planning for pilots.",
  },
};

export default async function AviationPage() {
  await requireUser(); // redirects to AuthKit sign-in if not signed in
  return (
    <>
      <Header />
      <AviationPlanner />
      <Footer />
    </>
  );
}
