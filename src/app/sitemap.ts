import type { MetadataRoute } from "next";
import {
  getAllLocationSlugsForSitemap,
  getAllCountryCodes,
  getAllProvinces,
  getFeaturedTagsFromDb,
} from "@/lib/db";
import { TAGS } from "@/lib/seed-tags";
import { logError } from "@/lib/observability";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { SITE_URL } from "@/lib/site";

export const dynamic = "force-dynamic";
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  // Priority tiers for sitelink signals:
  // 1.0     — homepage
  // 0.8-0.9 — primary navigation / sitelink candidates
  // 0.7     — secondary content pages
  // 0.3-0.5 — legal / utility pages
  const staticPages: MetadataRoute.Sitemap = [
    {
      url: SITE_URL,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 1.0,
    },
    {
      url: `${SITE_URL}/harare`,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 0.9,
    },
    {
      url: `${SITE_URL}/bulawayo`,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 0.9,
    },
    {
      url: `${SITE_URL}/victoria-falls`,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 0.9,
    },
    {
      url: `${SITE_URL}/history`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/aviation`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/help`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${SITE_URL}/about`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${SITE_URL}/status`,
      lastModified: now,
      changeFrequency: "always",
      priority: 0.6,
    },
    {
      url: `${SITE_URL}/explore`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    // Shamwari is omitted while paused (FLAGS.shamwari_chat) — the route
    // 404s, so it shouldn't be indexed.
    ...(isFeatureEnabled("shamwari_chat")
      ? [
          {
            url: `${SITE_URL}/shamwari`,
            lastModified: now,
            changeFrequency: "daily" as const,
            priority: 0.8,
          },
        ]
      : []),
    {
      url: `${SITE_URL}/embed`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${SITE_URL}/developers`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${SITE_URL}/privacy`,
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${SITE_URL}/terms`,
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];

  // Fetch all data from MongoDB in parallel
  let locations: { slug: string; tags: string[] }[] = [];
  let countryCodes: string[] = [];
  let provinces: { slug: string; countryCode: string }[] = [];
  let featuredTagSlugs: string[] = [];
  try {
    const [locs, codes, provs, tags] = await Promise.all([
      getAllLocationSlugsForSitemap(),
      getAllCountryCodes(),
      getAllProvinces(),
      getFeaturedTagsFromDb(),
    ]);
    locations = locs;
    countryCodes = codes;
    provinces = provs;
    // Fall back to seed tags if DB returns nothing (e.g. cold start / test environment)
    featuredTagSlugs =
      tags.length > 0
        ? tags.map((t) => t.slug)
        : TAGS.filter((t) => t.featured).map((t) => t.slug);
  } catch (err) {
    logError({
      source: "mongodb",
      severity: "medium",
      message: "Failed to load locations/countries for sitemap",
      error: err,
    });
    // Use seed tags as fallback so explore pages still appear in sitemap
    featuredTagSlugs = TAGS.filter((t) => t.featured).map((t) => t.slug);
  }

  // Explore tag pages — sourced from DB so new tags appear without deploys
  const explorePages: MetadataRoute.Sitemap = [
    {
      url: `${SITE_URL}/explore/country`,
      lastModified: now,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    },
    ...featuredTagSlugs.map((tag) => ({
      url: `${SITE_URL}/explore/${tag}`,
      lastModified: now,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
  ];

  // Country pages
  const countryPages: MetadataRoute.Sitemap = countryCodes.map((code) => ({
    url: `${SITE_URL}/explore/country/${code.toLowerCase()}`,
    lastModified: now,
    changeFrequency: "weekly" as const,
    priority: 0.6,
  }));

  // Harare, Bulawayo, and Victoria Falls are already in staticPages with boosted priority
  const boostedSlugs = new Set(["harare", "bulawayo", "victoria-falls"]);
  const locationPages: MetadataRoute.Sitemap = locations
    .filter((loc) => !boostedSlugs.has(loc.slug))
    .map((loc) => ({
      url: `${SITE_URL}/${loc.slug}`,
      lastModified: now,
      changeFrequency: "hourly" as const,
      priority: loc.tags.includes("city") ? 0.9 : 0.7,
    }));

  // Sub-route pages for each location (atmosphere, forecast, map)
  const subRoutePages: MetadataRoute.Sitemap = locations.flatMap((loc) => [
    {
      url: `${SITE_URL}/${loc.slug}/atmosphere`,
      lastModified: now,
      changeFrequency: "hourly" as const,
      priority: loc.tags.includes("city") ? 0.6 : 0.4,
    },
    {
      url: `${SITE_URL}/${loc.slug}/forecast`,
      lastModified: now,
      changeFrequency: "hourly" as const,
      priority: loc.tags.includes("city") ? 0.7 : 0.5,
    },
    {
      url: `${SITE_URL}/${loc.slug}/map`,
      lastModified: now,
      changeFrequency: "daily" as const,
      priority: loc.tags.includes("city") ? 0.5 : 0.3,
    },
  ]);

  // Province pages — /explore/country/{code}/{province-slug}
  const provincePages: MetadataRoute.Sitemap = provinces.map((p) => ({
    url: `${SITE_URL}/explore/country/${p.countryCode.toLowerCase()}/${p.slug}`,
    lastModified: now,
    changeFrequency: "weekly" as const,
    priority: 0.5,
  }));

  return [
    ...staticPages,
    ...explorePages,
    ...countryPages,
    ...provincePages,
    ...locationPages,
    ...subRoutePages,
  ];
}
