import "@/app/globals.css";
import type { Metadata } from "next";
import { SITE_URL } from "@/lib/site";
import { PageShell } from "@/components/layout/PageShell";
import { TermsContent } from "./TermsContent";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "Terms of Service for mukoko weather — a weather intelligence platform, operated by Mukoko Africa, a division of Nyuchi Africa (PVT) Ltd.",
  alternates: {
    canonical: `${SITE_URL}/terms`,
  },
};

export default function TermsPage() {
  return (
    <>
      <PageShell>
        <TermsContent />
      </PageShell>
    </>
  );
}
