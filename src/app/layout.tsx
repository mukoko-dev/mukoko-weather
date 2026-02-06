import type { Metadata } from "next";
import { FlagStrip } from "@/components/brand/FlagStrip";
import { ThemeProvider } from "@/components/brand/ThemeProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "mukoko weather — Zimbabwe Weather Intelligence",
    template: "%s | mukoko weather",
  },
  description:
    "AI-powered weather intelligence for Zimbabwe. Actionable forecasts for farming, mining, travel, and daily life across Harare, Bulawayo, Mutare, and all major cities.",
  keywords: [
    "Zimbabwe weather",
    "Harare weather",
    "Bulawayo weather",
    "Zimbabwe forecast",
    "farming weather Zimbabwe",
    "frost alert Zimbabwe",
    "mukoko",
    "Nyuchi Africa",
  ],
  authors: [{ name: "Nyuchi Africa", url: "https://nyuchi.com" }],
  openGraph: {
    title: "mukoko weather — Zimbabwe Weather Intelligence",
    description:
      "AI-powered weather intelligence for Zimbabwe. Actionable forecasts for farming, mining, travel, and daily life.",
    type: "website",
    locale: "en_ZW",
    siteName: "mukoko weather",
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Schema.org structured data for WebApplication
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "mukoko weather",
    description:
      "AI-powered weather intelligence platform for Zimbabwe, providing actionable forecasts for farming, mining, travel, and daily life.",
    url: "https://weather.mukoko.africa",
    applicationCategory: "WeatherApplication",
    operatingSystem: "Any",
    creator: {
      "@type": "Organization",
      name: "Nyuchi Africa",
      url: "https://nyuchi.com",
    },
    areaServed: {
      "@type": "Country",
      name: "Zimbabwe",
      identifier: "ZW",
    },
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      description: "Free weather intelligence for Zimbabwe",
    },
    inLanguage: ["en", "sn", "nd"],
  };

  return (
    <html
      lang="en"
      data-theme="light"
      data-brand="mukoko"
    >
      <head>
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" content="#4B0082" />
        <link rel="manifest" href="/manifest.json" />
        {/* Google Fonts loaded via link tags — works in all environments */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Noto+Serif:wght@400;700&family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <ThemeProvider>
          <FlagStrip />
          <div className="pl-0 min-[480px]:pl-1">
            {children}
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
