import "@/app/globals.css";
import type { Metadata } from "next";
import { SITE_URL } from "@/lib/site";
import { PageShell } from "@/components/layout/PageShell";
import { PrivacyContent } from "./PrivacyContent";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "Privacy Policy for mukoko weather. Learn how we handle your data — spoiler: we collect almost nothing.",
  alternates: {
    canonical: `${SITE_URL}/privacy`,
  },
};

export default function PrivacyPage() {
  return (
    <>
      <PageShell>
        <PrivacyContent />
      </PageShell>
    </>
  );
}
