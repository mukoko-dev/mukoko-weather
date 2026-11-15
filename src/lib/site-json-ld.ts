import { SITE_URL } from "@/lib/site";
import { breadcrumbJsonLd } from "@/lib/json-ld";

/**
 * The structured data every page carries: the application, the organisation,
 * the website with its search action, the main navigation and the root
 * breadcrumb. One list for the Next.js layout and the Astro shell, so the two
 * cannot drift. Shamwari is left out of the navigation while it is paused
 * (`shamwariChat` false): search engines should not index a page that 404s.
 */
export function siteJsonLd(shamwariChat: boolean): Record<string, unknown>[] {
  // Schema.org structured data for WebApplication
  const webAppSchema = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    "@id": `${SITE_URL}/#app`,
    name: "mukoko weather",
    alternateName: "Mukoko Weather",
    description:
      "Global weather intelligence platform providing actionable forecasts for farming, mining, travel, and daily life across 265+ locations worldwide.",
    url: SITE_URL,
    applicationCategory: "WeatherApplication",
    operatingSystem: "Any",
    browserRequirements: "Requires JavaScript",
    availableLanguage: [
      { "@type": "Language", name: "English", alternateName: "en" },
      { "@type": "Language", name: "Shona", alternateName: "sn" },
      { "@type": "Language", name: "Ndebele", alternateName: "nd" },
    ],
    creator: { "@id": `${SITE_URL}/#org` },
    publisher: { "@id": `${SITE_URL}/#org` },
    areaServed: { "@type": "Place", name: "World" },
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      description: "Free global weather intelligence",
      availability: "https://schema.org/InStock",
    },
    inLanguage: "en",
    featureList: [
      "Real-time weather conditions",
      "7-day weather forecasts",
      "24-hour hourly forecasts",
      "AI-powered weather summaries",
      "Frost alerts for farmers",
      "265+ weather locations",
      "Sunrise and sunset times",
    ],
  };

  // Organization schema for brand recognition + social profiles
  const orgSchema = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${SITE_URL}/#org`,
    name: "Nyuchi Africa (PVT) Ltd",
    legalName: "Nyuchi Africa (PVT) Ltd",
    url: "https://nyuchi.com",
    department: {
      "@type": "Organization",
      name: "Mukoko Africa",
      url: SITE_URL,
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
    "@id": `${SITE_URL}/#website`,
    name: "mukoko weather",
    alternateName: "Mukoko Weather",
    url: SITE_URL,
    publisher: { "@id": `${SITE_URL}/#org` },
    inLanguage: "en",
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${SITE_URL}/{location}`,
      },
      "query-input": "required name=location",
    },
  };

  // SiteNavigationElement — tells Google which pages are the primary
  // navigation structure. These become sitelink candidates in SERP.
  // Shamwari is omitted while paused (FLAGS.shamwari_chat) — we don't want
  // search engines indexing a page that 404s. Positions are stamped after
  // filtering so they stay contiguous regardless of the flag.
  const navItems = [
    {
      name: "Explore Locations",
      description: "Browse weather locations by category and country worldwide",
      url: `${SITE_URL}/explore`,
    },
    ...(shamwariChat
      ? [
          {
            name: "Shamwari AI",
            description:
              "AI-powered weather assistant for contextual advice and insights",
            url: `${SITE_URL}/shamwari`,
          },
        ]
      : []),
    {
      name: "Historical Weather Data",
      description:
        "Explore recorded weather trends and historical data worldwide",
      url: `${SITE_URL}/history`,
    },
    {
      name: "Help & FAQ",
      description:
        "How to use mukoko weather, frequently asked questions, and support",
      url: `${SITE_URL}/help`,
    },
    {
      name: "About",
      description: "About mukoko weather, Nyuchi Africa, and our data sources",
      url: `${SITE_URL}/about`,
    },
    {
      name: "System Status",
      description: "Real-time health status of mukoko weather services",
      url: `${SITE_URL}/status`,
    },
  ];

  const siteNavSchema = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "@id": `${SITE_URL}/#navigation`,
    name: "Main Navigation",
    itemListElement: navItems.map((item, i) => ({
      "@type": "SiteNavigationElement",
      position: i + 1,
      ...item,
    })),
  };

  // BreadcrumbList for site hierarchy — root level
  const breadcrumbSchema = breadcrumbJsonLd([], {
    root: "Home",
    id: `${SITE_URL}/#breadcrumb`,
  });

  return [
    webAppSchema,
    orgSchema,
    webSiteSchema,
    siteNavSchema,
    breadcrumbSchema,
  ];
}
