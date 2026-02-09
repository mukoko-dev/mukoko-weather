import type { MetadataRoute } from "next";
import { LOCATIONS } from "@/lib/locations";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = "https://weather.mukoko.africa";
  const now = new Date();

  const locationPages: MetadataRoute.Sitemap = LOCATIONS.map((loc) => ({
    url: `${baseUrl}/${loc.slug}`,
    lastModified: now,
    changeFrequency: "hourly" as const,
    priority: loc.tags.includes("city") ? 0.9 : 0.7,
  }));

  const staticPages: MetadataRoute.Sitemap = [
    {
      url: baseUrl,
      lastModified: now,
      changeFrequency: "hourly" as const,
      priority: 1.0,
    },
    {
      url: `${baseUrl}/about`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.5,
    },
    {
      url: `${baseUrl}/help`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    },
    {
      url: `${baseUrl}/privacy`,
      lastModified: now,
      changeFrequency: "yearly" as const,
      priority: 0.3,
    },
    {
      url: `${baseUrl}/terms`,
      lastModified: now,
      changeFrequency: "yearly" as const,
      priority: 0.3,
    },
  ];

  return [...staticPages, ...locationPages];
}
