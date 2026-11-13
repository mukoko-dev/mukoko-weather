"use client";

import { useEffect, useState } from "react";
import Script from "next/script";
import { usePathname } from "next/navigation";
import { sendSanitisedPageView, type Gtag } from "@/lib/ga-page-view";
import { storageMayStart } from "@/lib/rxdb/start-gate";
import { afterPaintWhenIdle } from "@/lib/weather-scenes/start-gate";

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

/**
 * True once the first screen has painted and the browser is idle: on the home
 * page when its weather has painted (the gate in `rxdb/start-gate.ts`), on any
 * other page two frames after it mounted, and in both cases the browser's next
 * idle moment.
 */
function useAfterFirstScreen(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let cancel: (() => void) | undefined;
    void storageMayStart().then(() => {
      if (!cancelled) cancel = afterPaintWhenIdle(() => setReady(true));
    });
    return () => {
      cancelled = true;
      cancel?.();
    };
  }, []);
  return ready;
}

export function GoogleAnalytics() {
  // gtag.js for this property is 181 KB gzipped (542 KB to parse, measured
  // 2026-11-13) and was preloaded in the head, so it shared a slow link with the
  // stylesheet and the app's scripts and then parsed on the main thread while
  // the weather was being drawn (issue 551). It now waits for the first screen.
  // The small inline script below still runs at once: it defines `gtag` and the
  // data layer, so a page view or a web vital sent before gtag.js arrives is
  // queued and delivered, not dropped. A visitor who leaves before the first
  // screen has painted is not counted; that is the price of not slowing them.
  const loadGtag = useAfterFirstScreen();
  return (
    <>
      {loadGtag && (
        <Script
          src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
          strategy="afterInteractive"
        />
      )}
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
