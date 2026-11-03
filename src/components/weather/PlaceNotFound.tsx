"use client";

import { CitySuggestions } from "@/components/layout/CitySuggestions";
import { NotFoundView } from "@/components/layout/NotFoundView";
import { LOCATIONS } from "@/lib/locations";

/** Twenty shipped cities, from the prebuilt catalogue (no lookup). */
const SUGGESTED_CITIES = LOCATIONS.filter((l) => l.tags.includes("city")).slice(
  0,
  20,
);

/**
 * "Location not found", shown in the browser when the Worker answered that it
 * holds no such place (issue #452). Same copy and layout as the server's
 * not-found page (`LocationNotFound`), with the suggestions taken from the
 * prebuilt catalogue instead of a database read. The page status is 200 (the
 * shell was already sent), so it says `noindex` itself.
 */
export function PlaceNotFound() {
  return (
    <>
      <meta name="robots" content="noindex" />
      <NotFoundView
        title="Location not found"
        message="We don't have weather data for that location yet."
        actions={[
          { href: "/explore", label: "Browse locations", primary: true },
        ]}
      >
        <CitySuggestions locations={SUGGESTED_CITIES} />
      </NotFoundView>
    </>
  );
}
