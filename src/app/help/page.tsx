import "@/app/globals.css";
import type { Metadata } from "next";
import { PageShell } from "@/components/layout/PageShell";
import { JsonLd } from "@/components/layout/JsonLd";
import { HelpContent, faqSchema } from "./HelpContent";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Help & FAQ",
  description:
    "Get help with mukoko weather — how to use forecasts, understand frost alerts, install the app, and more. Frequently asked questions about our weather intelligence platform.",
  alternates: {
    canonical: `${SITE_URL}/help`,
  },
};
export default function HelpPage() {
  return (
    <>
      <JsonLd data={faqSchema} />
      <PageShell>
        <HelpContent />
      </PageShell>
    </>
  );
}
