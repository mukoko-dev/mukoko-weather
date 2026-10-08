import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { isLocationSlug } from "@/lib/current-slug";
import type { PresetAnchor } from "@/lib/location-presets";
import { LocationsClient } from "./LocationsClient";

const BASE_URL = "https://weather.mukoko.com";

// A personal list (current location + saved places). Not a search landing
// page, so it is kept out of the index; the canonical still names the URL.
export const metadata: Metadata = {
  title: "Weather | mukoko weather",
  description:
    "Live weather for your current location and the places you have saved.",
  robots: { index: false, follow: false },
  alternates: {
    canonical: `${BASE_URL}/locations`,
  },
};

export default async function LocationsPage() {
  // The middleware remembers the last location visited (`lastLocation`). It
  // seeds the "My Location" card before the client store has rehydrated.
  const jar = await cookies();
  const remembered = jar.get("lastLocation")?.value;
  const initialCurrentSlug = isLocationSlug(remembered) ? remembered : null;

  // Rough position from the edge's IP geo headers. It anchors the suggested
  // places on first visit only (the client keeps a stored anchor).
  const h = await headers();
  const latHeader = h.get("x-vercel-ip-latitude");
  const lonHeader = h.get("x-vercel-ip-longitude");
  const lat = latHeader === null ? NaN : Number(latHeader);
  const lon = lonHeader === null ? NaN : Number(lonHeader);
  const ipAnchor: PresetAnchor | null =
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
      ? { lat, lon }
      : null;

  return (
    <>
      <Header />
      <main
        id="main-content"
        className="mx-auto max-w-3xl px-4 py-10 pb-28 sm:pb-10 sm:px-6 md:px-8"
      >
        <LocationsClient
          initialCurrentSlug={initialCurrentSlug}
          ipAnchor={ipAnchor}
        />
      </main>
      <Footer />
    </>
  );
}
