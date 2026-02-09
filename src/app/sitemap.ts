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

  return [
    {
      url: baseUrl,
      lastModified: now,
      changeFrequency: "hourly" as const,
      priority: 1.0,
    },
    ...locationPages,
  ];
}
