import type { Metadata } from "next";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { requireUser } from "@/lib/auth";
import { ApiKeysManager } from "./ApiKeysManager";

const BASE_URL = "https://weather.mukoko.com";

export const metadata: Metadata = {
  title: "API Keys",
  description:
    "Create and manage API keys for the mukoko weather developer API. The public weather API is free — keys are for attribution and future higher limits.",
  alternates: {
    canonical: `${BASE_URL}/developers/keys`,
  },
  robots: { index: false, follow: false },
  openGraph: {
    title: "API Keys | mukoko weather",
    description:
      "Create and manage API keys for the mukoko weather developer API.",
    url: `${BASE_URL}/developers/keys`,
    type: "website",
    locale: "en",
    siteName: "mukoko weather",
  },
};

export default async function ApiKeysPage() {
  // Gate: anonymous users are redirected to sign-in and land back here.
  await requireUser("/developers/keys");

  return (
    <>
      <Header />
      <main
        id="main-content"
        className="animate-fade-in mx-auto max-w-3xl px-4 py-8 pb-24 sm:px-6 sm:pb-8 md:px-8"
      >
        <h1 className="font-display text-3xl font-bold text-text-primary sm:text-4xl">
          API Keys
        </h1>
        <p className="gazelle mt-3">
          The mukoko weather and embed API is free and needs no key — it is
          rate-limited per IP. Create a key to attribute your usage and unlock
          higher limits as they roll out.
        </p>
        <ApiKeysManager />
      </main>
      <Footer />
    </>
  );
}
