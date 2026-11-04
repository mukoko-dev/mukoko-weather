"use client";

import { useEffect, useState } from "react";
import { ShareIcon } from "@/lib/weather-icons";

const BASE_URL = "https://weather.mukoko.com";

interface Props {
  slug?: string;
  locationName: string;
  /**
   * Where the control sits. `sky`: on the sky in the hero's top row (from `sm`
   * up), a `kestrel-round` button and a white note. `card`: inside the phone
   * icon group (`.hadeda`), a `duiker` button on a card surface and a note on
   * its own card surface, readable over the sky and over the cards that scroll
   * under the group.
   */
  variant: "sky" | "card";
}

/** The "Link copied" / "Copy failed" note while it shows, by variant. */
const NOTE_CLASS = {
  sky: "mt-1 text-[length:var(--text-body-sm)] leading-[var(--text-body-sm-leading)] font-semibold",
  card: "serval mt-3 px-3 py-1.5 text-[length:var(--text-body-sm)] leading-[var(--text-body-sm-leading)] font-semibold text-text-primary",
} as const;

/**
 * The round Share control for a place: the Web Share sheet where the browser
 * has one, else the link is copied and a note says so. The note is a polite
 * status region (empty and screen-reader-only until there is something to say).
 * One component for the hero's two homes: the top row on larger screens, the
 * phone icon group.
 */
export function ShareControl({ slug, locationName, variant }: Props) {
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
    const url = slug ? `${BASE_URL}/${slug}` : window.location.href;
    const shareData = {
      title: `${locationName} Weather`,
      text: `Check the weather in ${locationName} on mukoko weather`,
      url,
    };
    if (typeof navigator !== "undefined" && navigator.share) {
      navigator.share(shareData).catch(() => undefined);
    } else {
      navigator.clipboard
        .writeText(url)
        .then(() => {
          setCopied(true);
        })
        .catch(() => {
          setCopyFailed(true);
        });
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleShare}
        aria-label={`Share weather for ${locationName}`}
        className={variant === "card" ? "duiker" : "kestrel-round"}
      >
        <ShareIcon size={20} />
      </button>
      <span
        role="status"
        className={
          copied || copyFailed
            ? `absolute top-full right-0 whitespace-nowrap ${NOTE_CLASS[variant]}`
            : "sr-only"
        }
      >
        {copied ? "Link copied" : copyFailed ? "Copy failed" : ""}
      </span>
    </div>
  );
}
