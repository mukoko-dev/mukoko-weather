import type { MetadataRoute } from "next";
import { getAllLocationsFromDb } from "@/lib/db";
import { logError } from "@/lib/observability";

export const dynamic = "force-dynamic";
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = "https://weather.mukoko.com";
  const now = new Date();

  // Priority tiers for sitelink signals:
  // 1.0     — homepage
  // 0.8-0.9 — primary navigation / sitelink candidates
  // 0.7     — secondary content pages
  // 0.3-0.5 — legal / utility pages
  const staticPages: MetadataRoute.Sitemap = [
    {
      url: baseUrl,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 1.0,
    },
    {
      url: `${baseUrl}/harare`,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 0.9,
    },
    {
      url: `${baseUrl}/bulawayo`,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 0.9,
    },
    {
      url: `${baseUrl}/victoria-falls`,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 0.9,
    },
    {
      url: `${baseUrl}/history`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/help`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${baseUrl}/about`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${baseUrl}/status`,
      lastModified: now,
      changeFrequency: "always",
      priority: 0.6,
    },
    {
      url: `${baseUrl}/explore`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/embed`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${baseUrl}/privacy`,
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${baseUrl}/terms`,
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];

  // Explore tag pages
  const exploreTags = ["city", "farming", "mining", "tourism", "national-park", "education", "border", "travel"];
  const explorePages: MetadataRoute.Sitemap = exploreTags.map((tag) => ({
    url: `${baseUrl}/explore/${tag}`,
    lastModified: now,
    changeFrequency: "weekly" as const,
    priority: 0.7,
  }));

  // Fetch all locations from MongoDB
  let locations: { slug: string; tags: string[] }[] = [];
  try {
    locations = await getAllLocationsFromDb();
  } catch (err) {
    logError({
      source: "mongodb",
      severity: "medium",
      message: "Failed to load locations for sitemap",
      error: err,
    });
  }

  // Harare, Bulawayo, and Victoria Falls are already in staticPages with boosted priority
  const boostedSlugs = new Set(["harare", "bulawayo", "victoria-falls"]);
  const locationPages: MetadataRoute.Sitemap = locations
    .filter((loc) => !boostedSlugs.has(loc.slug))
    .map((loc) => ({
      url: `${baseUrl}/${loc.slug}`,
      lastModified: now,
      changeFrequency: "hourly" as const,
      priority: loc.tags.includes("city") ? 0.9 : 0.7,
    }));

  // Sub-route pages for each location (atmosphere, forecast, map)
  const subRoutePages: MetadataRoute.Sitemap = locations.flatMap((loc) => [
    {
      url: `${baseUrl}/${loc.slug}/atmosphere`,
      lastModified: now,
      changeFrequency: "hourly" as const,
      priority: loc.tags.includes("city") ? 0.6 : 0.4,
    },
    {
      url: `${baseUrl}/${loc.slug}/forecast`,
      lastModified: now,
      changeFrequency: "hourly" as const,
      priority: loc.tags.includes("city") ? 0.7 : 0.5,
    },
    {
      url: `${baseUrl}/${loc.slug}/map`,
      lastModified: now,
      changeFrequency: "daily" as const,
      priority: loc.tags.includes("city") ? 0.5 : 0.3,
    },
  ]);

  return [...staticPages, ...explorePages, ...locationPages, ...subRoutePages];
}
