import type { Metadata } from "next";
import { MineralsStripe } from "@/components/brand/MineralsStripe";
import { ThemeProvider } from "@/components/brand/ThemeProvider";
import { GoogleAnalytics } from "@/components/analytics/GoogleAnalytics";
import "./globals.css";

const BASE_URL = "https://weather.mukoko.com";

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: "mukoko weather — Zimbabwe Weather Intelligence",
    template: "%s | mukoko weather",
  },
  description:
    "AI-powered weather intelligence for Zimbabwe. Accurate forecasts, frost alerts, and actionable insights for farming, mining, travel, and daily life across Harare, Bulawayo, Mutare, and 90+ locations.",
  keywords: [
    "Zimbabwe weather",
    "Zimbabwe weather forecast",
    "Harare weather",
    "Bulawayo weather",
    "Mutare weather",
    "Gweru weather",
    "Masvingo weather",
    "Victoria Falls weather",
    "Zimbabwe forecast today",
    "Zimbabwe 7 day forecast",
    "farming weather Zimbabwe",
    "frost alert Zimbabwe",
    "Zimbabwe rain forecast",
    "Zimbabwe temperature",
    "weather Harare today",
    "Zimbabwe climate",
    "mukoko",
    "mukoko weather",
    "Nyuchi Africa",
  ],
  authors: [{ name: "Nyuchi Web Services", url: "https://nyuchi.com" }],
  creator: "Mukoko Africa",
  publisher: "Nyuchi Africa (PVT) Ltd",
  alternates: {
    canonical: BASE_URL,
    languages: {
      "en": BASE_URL,
      "x-default": BASE_URL,
    },
  },
  openGraph: {
    title: "mukoko weather — Zimbabwe Weather Intelligence",
    description:
      "AI-powered weather intelligence for Zimbabwe. Accurate forecasts, frost alerts, and actionable insights for farming, mining, travel, and daily life across 90+ locations.",
    type: "website",
    locale: "en_ZW",
    url: BASE_URL,
    siteName: "mukoko weather",
  },
  twitter: {
    card: "summary_large_image",
    title: "mukoko weather — Zimbabwe Weather Intelligence",
    description:
      "AI-powered weather intelligence for Zimbabwe. Forecasts for farming, mining, travel, and daily life.",
    creator: "@mukokoafrica",
    site: "@mukokoafrica",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  category: "weather",
  verification: {},
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Schema.org structured data for WebApplication
  const webAppSchema = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    "@id": `${BASE_URL}/#app`,
    name: "mukoko weather",
    alternateName: "Mukoko Weather Zimbabwe",
    description:
      "AI-powered weather intelligence platform for Zimbabwe, providing actionable forecasts for farming, mining, travel, and daily life across 90+ locations.",
    url: BASE_URL,
    applicationCategory: "WeatherApplication",
    operatingSystem: "Any",
    browserRequirements: "Requires JavaScript",
    availableLanguage: [
      { "@type": "Language", name: "English", alternateName: "en" },
      { "@type": "Language", name: "Shona", alternateName: "sn" },
      { "@type": "Language", name: "Ndebele", alternateName: "nd" },
    ],
    creator: { "@id": `${BASE_URL}/#org` },
    publisher: { "@id": `${BASE_URL}/#org` },
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
      availability: "https://schema.org/InStock",
    },
    inLanguage: "en",
    featureList: [
      "Real-time weather conditions",
      "7-day weather forecasts",
      "24-hour hourly forecasts",
      "AI-powered weather summaries",
      "Frost alerts for farmers",
      "90+ Zimbabwe locations",
      "Sunrise and sunset times",
    ],
  };

  // Organization schema for brand recognition + social profiles
  const orgSchema = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${BASE_URL}/#org`,
    name: "Nyuchi Africa (PVT) Ltd",
    legalName: "Nyuchi Africa (PVT) Ltd",
    url: "https://nyuchi.com",
    department: {
      "@type": "Organization",
      name: "Mukoko Africa",
      url: BASE_URL,
    },
    brand: {
      "@type": "Brand",
      name: "mukoko weather",
    },
    email: "hi@mukoko.com",
    contactPoint: [
      {
        "@type": "ContactPoint",
        email: "support@mukoko.com",
        contactType: "customer support",
        availableLanguage: ["en", "sn"],
      },
      {
        "@type": "ContactPoint",
        email: "legal@nyuchi.com",
        contactType: "legal",
      },
    ],
    sameAs: [
      "https://twitter.com/mukokoafrica",
      "https://instagram.com/mukoko.africa",
    ],
    knowsLanguage: ["en", "sn", "nd"],
  };

  // WebSite schema with search action for sitelinks search box
  const webSiteSchema = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${BASE_URL}/#website`,
    name: "mukoko weather",
    alternateName: "Mukoko Weather",
    url: BASE_URL,
    publisher: { "@id": `${BASE_URL}/#org` },
    inLanguage: "en",
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${BASE_URL}/{location}`,
      },
      "query-input": "required name=location",
    },
  };

  return (
    <html
      lang="en"
      dir="ltr"
      data-brand="mukoko-weather"
      suppressHydrationWarning
    >
      <head>
        {/* Prevent flash of wrong theme — runs before first paint */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=JSON.parse(localStorage.getItem("mukoko-weather-prefs")||"{}");var t=(s.state&&s.state.theme)||"system";if(t==="system"){t=window.matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light"}document.documentElement.setAttribute("data-theme",t)}catch(e){document.documentElement.setAttribute("data-theme","light")}})();`,
          }}
        />
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" content="#0047AB" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#0A0A0A" media="(prefers-color-scheme: dark)" />
        {/* Mobile-first: optimised for Android & Huawei devices */}
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="format-detection" content="telephone=no" />
        <link rel="manifest" href="/manifest.json" />
        {/* Specialty fonts for headings, display text, and data only — body uses system fonts */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Noto+Serif:wght@400;700&family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify([webAppSchema, orgSchema, webSiteSchema]) }}
        />
      </head>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <GoogleAnalytics />
        {/* Skip navigation link for keyboard/screen reader users — WCAG 2.4.1 */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-[var(--radius-button)] focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground focus:shadow-lg focus:outline-none"
        >
          Skip to main content
        </a>
        <ThemeProvider>
          <MineralsStripe />
          <div className="pl-0 min-[480px]:pl-1">
            {children}
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
