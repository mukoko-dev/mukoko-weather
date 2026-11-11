"use client";

import { useEffect, useState } from "react";
import { ShareIcon } from "@/lib/weather-icons";
import type { SkyHeroPlace } from "@/lib/sky-hero";

const BASE_URL = "https://weather.mukoko.com";
const SITE_TITLE = "mukoko weather";

/** The name of the control, and its tooltip, on any page that is not a place. */
export const SHARE_PAGE_LABEL = "Share this page";

/** The control's accessible name: the place when a place is on screen. */
export function shareLabel(place: SkyHeroPlace | null | undefined): string {
  return place ? `Share weather for ${place.name}` : SHARE_PAGE_LABEL;
}

/** What the browser's share sheet is given. */
export interface ShareDetails {
  title: string;
  text?: string;
  url: string;
}

/**
 * An address with no query string and no fragment, so a shared link can never
 * carry state with it (a search, a token a redirect left in the bar, an
 * anchor). No page that shows the group reads its query or fragment (only the
 * wall display and the embed's widget do, and they have no group), so nothing
 * a visitor sees is lost. An address that will not parse is returned as it
 * was.
 */
export function pageAddress(href: string): string {
  try {
    const url = new URL(href);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return href;
  }
}

/**
 * What is shared. A place shares its own address
 * (`https://weather.mukoko.com/{slug}`, which is the same for the person who
 * receives it wherever they are; the home page's `/` is not) with the place's
 * title and a sentence. Any other page shares the address it is on, without
 * its query string or fragment, and its title: the document's, as the browser
 * shows it in a tab.
 */
export function buildShareData(
  place: SkyHeroPlace | null | undefined,
  page: { href: string; title: string },
): ShareDetails {
  const address = pageAddress(page.href);
  if (place) {
    return {
      title: `${place.name} Weather`,
      text: `Check the weather in ${place.name} on mukoko weather`,
      url: place.slug ? `${BASE_URL}/${place.slug}` : address,
    };
  }
  return { title: page.title || SITE_TITLE, url: address };
}

interface Props {
  /** The place on screen, if any. Without one the control shares the page. */
  place?: SkyHeroPlace | null;
}

/**
 * The Share control of the Quick actions group, the same on every page: the
 * Web Share sheet where the browser has one, else the link is copied and a
 * note says so. The note is a polite status region (empty and screen-reader-only
 * until there is something to say) and sits on its own card surface, so it
 * reads over the sky and over the cards that scroll under the group.
 */
export function ShareControl({ place }: Props) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  useEffect(() => {
    if (!copyFailed) return;
    const t = setTimeout(() => setCopyFailed(false), 2000);
    return () => clearTimeout(t);
  }, [copyFailed]);

  function handleShare() {
    const shareData = buildShareData(place, {
      href: window.location.href,
      title: document.title,
    });
    if (typeof navigator !== "undefined" && navigator.share) {
      navigator.share(shareData).catch(() => undefined);
    } else if (!navigator.clipboard) {
      // Insecure origins have no clipboard: say so rather than throw.
      setCopyFailed(true);
    } else {
      navigator.clipboard
        .writeText(shareData.url)
        .then(() => {
          setCopied(true);
        })
        .catch(() => {
          setCopyFailed(true);
        });
    }
  }

  const label = shareLabel(place);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleShare}
        aria-label={label}
        title={label}
        data-share-trigger
        className="bee"
      >
        <ShareIcon size={20} />
      </button>
      <span
        role="status"
        className={
          copied || copyFailed
            ? "serval absolute top-full right-0 mt-3 whitespace-nowrap px-3 py-1.5 text-[length:var(--text-body-sm)] leading-[var(--text-body-sm-leading)] font-semibold text-text-primary"
            : "sr-only"
        }
      >
        {copied ? "Link copied" : copyFailed ? "Copy failed" : ""}
      </span>
    </div>
  );
}
