"use client";

import { useEffect } from "react";
import Script from "next/script";
import { usePathname } from "next/navigation";
import { sendSanitisedPageView, type Gtag } from "@/lib/ga-page-view";

const GA_MEASUREMENT_ID = "G-4KB2ZS573N";
const MAX_WAIT_TRIES = 20;
const WAIT_MS = 250;

/**
 * Sends a sanitised page hit on mount and on every route change. GA4's own
 * automatic page_view would send `document.location`, which for a spot is
 * `/name--<7-char geohash>` (~153 m); it is turned off in the config.
 *
 * gtag.js loads after interaction, so the effect waits (briefly) for `gtag`
 * rather than dropping the first view.
 *
 * Owner step: in GA4 Admin > Data streams > Enhanced measurement, turn off
 * "Page changes based on browser history events", otherwise GA4 also emits
 * its own page_view for client navigation.
 */
function PageViewTracker() {
  const pathname = usePathname();
  useEffect(() => {
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = () => {
      const gtag = (window as unknown as { gtag?: Gtag }).gtag;
      if (typeof gtag !== "function") {
        if (tries++ < MAX_WAIT_TRIES) timer = setTimeout(send, WAIT_MS);
        return;
      }
      sendSanitisedPageView(gtag, {
        origin: window.location.origin,
        pathname: window.location.pathname,
        search: window.location.search,
        title: document.title,
        referrer: document.referrer,
      });
    };
    send();
    return () => {
      if (timer) clearTimeout(timer);
    };
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
