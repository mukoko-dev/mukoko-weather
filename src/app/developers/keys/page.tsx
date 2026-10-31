import type { Metadata } from "next";
import { PageShell } from "@/components/layout/PageShell";
import { requireUser } from "@/lib/auth";
import { ApiKeysManager } from "./ApiKeysManager";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "API Keys",
  description:
    "Create and manage API keys for the mukoko weather developer API. The public weather API is free — keys are for attribution and future higher limits.",
  alternates: {
    canonical: `${SITE_URL}/developers/keys`,
  },
  robots: { index: false, follow: false },
  openGraph: {
    title: "API Keys | mukoko weather",
    description:
      "Create and manage API keys for the mukoko weather developer API.",
    url: `${SITE_URL}/developers/keys`,
    type: "website",
    locale: "en",
    siteName: "mukoko weather",
  },
};

export default async function ApiKeysPage() {
  // Gate: anonymous users are redirected to sign-in and land back here.
  await requireUser("/developers/keys");

  return (
    <PageShell
      breadcrumb={[
        { label: "Home", href: "/" },
        { label: "Developers", href: "/developers" },
        { label: "API keys" },
      ]}
    >
      <h1 className="elephant">API Keys</h1>
      <p className="gazelle mt-3">
        The mukoko weather and embed API is free and needs no key — it is
        rate-limited per IP. Create a key to attribute your usage and unlock
        higher limits as they roll out.
      </p>
      <ApiKeysManager />
    </PageShell>
  );
}
