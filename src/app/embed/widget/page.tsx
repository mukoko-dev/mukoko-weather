import type { Metadata } from "next";
import { MukokoWeatherEmbed, type EmbedType } from "@/components/embed";
import "./widget.css";

/**
 * Standalone iframe target for the weather widget.
 *
 * This is the URL people put in an <iframe src>. It renders ONLY the widget —
 * no Header, Footer, or nav — so it drops cleanly into any third-party page.
 *
 *   /embed/widget?type=current|today|5day|7day
 *                &location=<slug>            (or)
 *                &lat=<n>&lon=<n>            (or)
 *                (none — visitor's IP location)
 *                &theme=auto|light|dark
 *
 * The underlying MukokoWeatherEmbed component fetches the public embed API
 * (`/api/embed/current`) client-side, so this page needs no data fetching.
 */

export const metadata: Metadata = {
  title: "Weather widget",
  description: "Embeddable mukoko weather widget.",
  // Embed targets are meant to live inside other pages, not to be indexed.
  robots: { index: false, follow: false },
};

const VALID_TYPES: EmbedType[] = ["current", "today", "5day", "7day"];

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseType(value: string | undefined): EmbedType {
  return VALID_TYPES.includes(value as EmbedType)
    ? (value as EmbedType)
    : "current";
}

function parseTheme(value: string | undefined): "light" | "dark" | "auto" {
  return value === "light" || value === "dark" ? value : "auto";
}

function parseNum(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export default async function EmbedWidgetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  const type = parseType(first(sp.type));
  // Accept both `location` (documented) and `slug` (API param name) for the slug.
  const location = first(sp.location) ?? first(sp.slug);
  const lat = parseNum(first(sp.lat));
  const lon = parseNum(first(sp.lon));
  const theme = parseTheme(first(sp.theme));

  return (
    <main className="mkw-embed-host" aria-label="mukoko weather widget">
      <MukokoWeatherEmbed
        type={type}
        location={location}
        lat={lat}
        lon={lon}
        theme={theme}
      />
    </main>
  );
}
