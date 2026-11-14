import type { Metadata } from "next";
import { CriticalStyles } from "@/components/layout/FirstScreenStyles";
import { breadcrumbJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/metadata";
import { resolveLocationParam } from "@/lib/load-location";
import { localPlaceForSlug } from "@/lib/local-place";
import { localSeason } from "@/lib/season-local";
import { JsonLd } from "@/components/layout/JsonLd";
import { PlaceResolver } from "@/components/weather/PlaceResolver";
import { PlaceStage } from "@/components/weather/PlaceStage";
import { SITE_URL } from "@/lib/site";
import { countryDisplayName, placeLine } from "@/lib/location-country";
import { placeAdminPcode } from "@/lib/admin-pcodes";

export const dynamic = "force-dynamic";
export async function generateMetadata({
  params,
}: {
  params: Promise<{ location: string }>;
}): Promise<Metadata> {
  // A shipped place or a spot needs no lookup. Only another slug asks the
  // store, and metadata streams after the shell for a browser (a crawler
  // still gets it with the page), so that wait never holds a visitor.
  const { location: slug } = await params;
  const stored =
    localPlaceForSlug(slug) ?? (await resolveLocationParam(params));
  if (!stored) return buildPageMetadata({ notFound: true });
  // Metadata has no forecast to reconcile against, so a region borrowed from
  // a seed (possibly across a border) is left out rather than indexed.
  const loc = stored.regionApproximate
    ? { ...stored, country: "", province: "" }
    : stored;

  const countryCode = loc.country ?? "";
  const countryName = countryDisplayName(countryCode);

  const title = `${loc.name} Weather Today — Forecast & Conditions`;
  const description = `Current weather conditions, 7-day forecast, and hourly predictions for ${placeLine(loc.name, loc.province, countryName)}. Weather intelligence with frost alerts, farming insights, and accurate temperature data from mukoko weather.`;

  // Build dynamic OG image URL with the location-specific season, from the
  // prebuilt season table (no database read). Note: the OG route accepts
  // `temp` and `condition` params, but we intentionally omit them here —
  // fetching weather data purely for OG metadata would add a round-trip to
  // every SSR render.
  const seasonName = localSeason(
    new Date(),
    loc.country ?? "",
    loc.lat ?? 0,
  ).name;
  const ogParams = new URLSearchParams({
    title: `${loc.name} Weather`,
    subtitle: `Live forecast for ${placeLine(loc.province, countryName) || loc.name}`,
    location: loc.name,
    province: loc.province,
    ...(seasonName && { season: seasonName }),
    template: "location",
  });
  const ogImageUrl = `${SITE_URL}/api/og?${ogParams.toString()}`;

  const keywords = [
    `${loc.name} weather`,
    `${loc.name} weather today`,
    `${loc.name} forecast`,
    `${loc.name} temperature`,
    `weather in ${loc.name} ${countryName}`,
    `${loc.province} weather`,
    `${loc.name} 7 day forecast`,
    `${loc.name} rain forecast`,
    `${countryName} weather`,
    "mukoko weather",
  ]
    .map((k) => k.trim())
    .filter((k) => k && k !== "weather");

  return buildPageMetadata({
    title,
    description,
    path: `/${loc.slug}`,
    keywords,
    og: {
      title: `${loc.name} Weather | mukoko weather`,
      description: `Live weather forecast for ${placeLine(loc.name, loc.province, countryName)}. Current conditions, 7-day outlook, and local insights.`,
      image: {
        url: ogImageUrl,
        width: 1200,
        height: 630,
        alt: `${loc.name} weather forecast`,
      },
    },
    twitter: {
      title: `${loc.name} Weather | mukoko weather`,
      description: `Live weather for ${loc.name}, ${countryName} — current conditions, 7-day forecast, and local insights.`,
      images: [ogImageUrl],
    },
  });
}

/**
 * The place page: the shell, the place and its structured data. It makes NO
 * weather call (issue #414) and waits for no data at all (issue #452): the
 * forecast is fetched by the visitor's own browser and painted over the copy
 * stored on the device, and everything the server sends is known without a
 * lookup:
 *
 * - the place: a shipped place from the seed, a spot from its own slug
 *   (`localPlaceForSlug`). Any other slug is resolved by the browser
 *   (`PlaceResolver`), which shows the not-found view there when the Worker
 *   holds no such place; the edge proxy still answers a real 404 for the
 *   slugs it can tell are unknown;
 * - the season: the prebuilt table (`localSeason`), not a database read;
 * - the country name: the static country list;
 * - the signed-in person: not sent at all; the client reads it from
 *   AuthKit's provider (`useAiUser`).
 *
 * Structured data: Place, BreadcrumbList and FAQPage need no forecast and
 * stay. The Observation block (current temperature, humidity, wind, …) is
 * dropped rather than filled from a cache read: a cache read here is an
 * upstream call on a miss, and a stale observation in JSON-LD is worse than
 * none.
 */
export default async function LocationPage({
  params,
}: {
  params: Promise<{ location: string }>;
}) {
  const { location: slug } = await params;
  const location = localPlaceForSlug(slug);
  if (!location)
    return (
      <>
        <CriticalStyles />
        <PlaceResolver slug={slug} />
      </>
    );

  const countryCode = (location.country ?? "").toUpperCase();
  const season = localSeason(new Date(), countryCode, location.lat ?? 0, {
    region: placeAdminPcode(location),
  });
  const countryName = countryDisplayName(countryCode);
  const now = new Date().toISOString();

  // Structured data states only what the page knows for certain. A country
  // borrowed from a nearby seed (`regionApproximate`) and a placeholder
  // elevation (`elevationApproximate`) are what the forecast corrects in the
  // browser; indexing them would publish a guess.
  const schemaCountry = location.regionApproximate ? "" : countryCode;
  const schemaProvince = location.regionApproximate ? "" : location.province;
  const schemaCountryName = location.regionApproximate ? "" : countryName;
  const knownElevation = !location.elevationApproximate;

  // ── Schema.org structured data (SEO — server only) ──────────────────────
  const pageSchema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": `${SITE_URL}/${location.slug}`,
    name: `${location.name} Weather Forecast`,
    description: `Current weather and 7-day forecast for ${placeLine(location.name, schemaProvince, schemaCountryName)}`,
    url: `${SITE_URL}/${location.slug}`,
    datePublished: now,
    dateModified: now,
    inLanguage: "en",
    isPartOf: { "@id": `${SITE_URL}/#website` },
    publisher: { "@id": `${SITE_URL}/#org` },
    mainEntity: {
      "@type": "Place",
      "@id": `${SITE_URL}/${location.slug}#place`,
      name: location.name,
      geo: {
        "@type": "GeoCoordinates",
        latitude: location.lat,
        longitude: location.lon,
        ...(knownElevation
          ? {
              elevation: {
                "@type": "QuantitativeValue",
                value: location.elevation,
                unitCode: "MTR",
                unitText: "metres",
              },
            }
          : {}),
      },
      address: {
        "@type": "PostalAddress",
        ...(schemaProvince ? { addressRegion: schemaProvince } : {}),
        // An open-ocean spot has no country: omit the property rather than
        // publish an empty ISO 3166-1 code.
        ...(schemaCountry ? { addressCountry: schemaCountry } : {}),
      },
      ...(schemaCountry
        ? {
            containedInPlace: {
              "@type": "Country",
              name: schemaCountryName,
              identifier: schemaCountry,
            },
          }
        : {}),
    },
  };

  const breadcrumbSchema = breadcrumbJsonLd([
    { name: schemaProvince },
    { name: `${location.name} Weather`, path: `/${location.slug}` },
  ]);

  // Only the question the page can answer without a forecast.
  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: `What province is ${location.name} in?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: `${location.name} is located in ${placeLine(schemaProvince && `${schemaProvince} province`, schemaCountryName) || "an unmapped area"}${knownElevation ? `, at an elevation of ${location.elevation} metres above sea level` : ""}.`,
        },
      },
    ],
  };

  return (
    <>
      <CriticalStyles />
      {/* SEO schemas — server rendered only */}
      <JsonLd data={[pageSchema, breadcrumbSchema, faqSchema]} />

      {/* The shell and the place; the weather arrives in the browser. */}
      <PlaceStage seed={{ location, season, countryName }} />
    </>
  );
}
