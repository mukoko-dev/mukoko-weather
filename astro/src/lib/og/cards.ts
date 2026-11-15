/**
 * Every card the build makes: the site card, one per page that has its own,
 * and one per place the platform ships (`LOCATIONS`, the seed the Next.js
 * place page also reads). The place pages are not served from Astro yet; the
 * cards exist so either app can point at them.
 */
import { LOCATIONS, type WeatherLocation } from "@/lib/locations";
import { countryDisplayName, placeLine } from "@/lib/location-country";
import { SITE_URL } from "@/lib/site";
import { DEFAULT_TITLE, TWITTER_DESCRIPTION } from "~/lib/seo";
import type { CardSpec } from "./card";
import { PAGE_CARDS, SITE_CARD_SLUG, locationSlug, pageSlug } from "./pages";
import { clean, isRenderable, nameFromSlug, truncate } from "./text";

export interface OgCard {
  /** Path under /og without the extension: "site", "pages/terms", "locations/harare". */
  slug: string;
  alt: string;
  spec: CardSpec;
}

const HOST = SITE_URL.replace(/^https?:\/\//, "");

export const siteCard = (): OgCard => ({
  slug: SITE_CARD_SLUG,
  alt: DEFAULT_TITLE,
  spec: {
    eyebrow: "Global Weather Intelligence",
    title: "mukoko weather",
    description: TWITTER_DESCRIPTION,
    domain: HOST,
  },
});

export const pageCards = (): OgCard[] =>
  PAGE_CARDS.map((p) => ({
    slug: pageSlug(p.path),
    alt: `${p.title} | mukoko weather`,
    spec: {
      eyebrow: "mukoko weather",
      title: p.title,
      description: p.description,
      domain: `${HOST}${p.path}`,
    },
  }));

/** What a place is known for, from its tags: one clause of the card's line. */
function offering(tags: readonly string[]): string {
  if (tags.includes("farming")) return "frost alerts and farming insights";
  if (tags.includes("mining")) return "conditions for mining work";
  if (tags.includes("national-park") || tags.includes("tourism"))
    return "travel and tourism conditions";
  return "local insights";
}

export function locationCard(loc: WeatherLocation): OgCard {
  // A name the bundled fonts cannot draw would be empty boxes; the slug is
  // always plain ASCII.
  const name = clean(loc.name);
  const shown = name && isRenderable(name) ? name : nameFromSlug(loc.slug);
  const country = countryDisplayName(loc.country);
  const region =
    loc.province && clean(loc.province) !== name && isRenderable(loc.province)
      ? clean(loc.province)
      : "";
  return {
    slug: locationSlug(loc.slug),
    alt: `${shown} weather forecast`,
    spec: {
      eyebrow: [country, region].filter(Boolean).join(" · ") || "Weather",
      title: shown,
      description: `Live forecast, 7-day outlook and ${offering(loc.tags)} for ${placeLine(truncate(shown, 36), country)}.`,
      domain: `${HOST}/${loc.slug}`,
    },
  };
}

export const locationCards = (): OgCard[] => LOCATIONS.map(locationCard);

export const allCards = (): OgCard[] => [
  siteCard(),
  ...pageCards(),
  ...locationCards(),
];
