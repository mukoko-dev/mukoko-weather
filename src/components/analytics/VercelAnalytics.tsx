"use client";

import { Analytics } from "@vercel/analytics/next";
import { sanitizeUrl } from "@/lib/location-privacy";

/** Vercel Web Analytics with the URL coarsened (no fine geohash, no query). */
export function VercelAnalytics() {
  return <Analytics beforeSend={(e) => ({ ...e, url: sanitizeUrl(e.url) })} />;
}
