import type { Metadata } from "next";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { requireUser } from "@/lib/auth";
import { AviationPlanner } from "./AviationPlanner";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Aviation Weather Briefing | mukoko weather",
  description:
    "Pre-flight weather briefing for pilots. METAR, TAF, flight conditions, and PDF trip plan generation for African and global airports.",
  alternates: { canonical: `${SITE_URL}/aviation` },
  openGraph: {
    title: "Aviation Weather Briefing | mukoko weather",
    description: "Pre-flight METAR, TAF, and PDF trip planning for pilots.",
  },
};

export default async function AviationPage() {
  await requireUser("/aviation"); // redirects anon users to sign-in, returns here after
  return (
    <>
      <Header />
      <AviationPlanner />
      <Footer />
    </>
  );
}
