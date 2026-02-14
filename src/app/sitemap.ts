import type { MetadataRoute } from "next";
import { LOCATIONS } from "@/lib/locations";

export const dynamic = "force-dynamic";
export const revalidate = 3600;

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = "https://weather.mukoko.com";
  const now = new Date();

  const staticPages: MetadataRoute.Sitemap = [
    {
      url: baseUrl,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 1.0,
    },
    {
      url: `${baseUrl}/about`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${baseUrl}/help`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${baseUrl}/history`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.7,
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

  const locationPages: MetadataRoute.Sitemap = LOCATIONS.map((loc) => ({
    url: `${baseUrl}/${loc.slug}`,
    lastModified: now,
    changeFrequency: "hourly" as const,
    priority: loc.tags.includes("city") ? 0.9 : 0.7,
  }));

  // Sub-route pages for each location (atmosphere, forecast)
  const subRoutePages: MetadataRoute.Sitemap = LOCATIONS.flatMap((loc) => [
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
  ]);

  return [...staticPages, ...locationPages, ...subRoutePages];
}
