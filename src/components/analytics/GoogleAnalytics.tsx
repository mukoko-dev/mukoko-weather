"use client";

import { useEffect } from "react";
import Script from "next/script";
import { usePathname } from "next/navigation";
import { sanitizePath, sanitizeUrl } from "@/lib/location-privacy";

const GA_MEASUREMENT_ID = "G-4KB2ZS573N";

/**
 * Sends page_view with a coarsened path. GA4's automatic page_view would send
 * `document.location`, which for a spot is `/name--<7-char geohash>` (~153 m).
 * Automatic views are turned off in the config; SPA route changes are sent here.
 *
 * Owner step: in GA4 Admin > Data streams > Enhanced measurement, turn off
 * "Page changes based on browser history events", otherwise GA4 also emits its
 * own page_view with the raw URL on client navigation.
 */
function PageViewTracker() {
  const pathname = usePathname();
  useEffect(() => {
    const gtag = (window as unknown as { gtag?: (...a: unknown[]) => void })
      .gtag;
    if (typeof gtag !== "function") return;
    const safePath = sanitizePath(pathname || "/");
    const fine = safePath !== (pathname || "/");
    gtag("event", "page_view", {
      page_path: safePath,
      page_location: `${window.location.origin}${safePath}`,
      page_title: fine ? "mukoko weather" : document.title,
      page_referrer: sanitizeUrl(document.referrer),
    });
  }, [pathname]);
  return null;
}

export function GoogleAnalytics() {
  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
        strategy="afterInteractive"
      />
      <Script id="google-analytics" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${GA_MEASUREMENT_ID}', { send_page_view: false });
        `}
      </Script>
      <PageViewTracker />
    </>
  );
}
