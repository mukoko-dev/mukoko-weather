import { NextRequest, NextResponse } from "next/server";
import { findNearestLocationsFromDb, createLocation, findDuplicateLocation, upsertCountry, upsertProvince, isInSupportedRegionFromDb, getCountryByCode } from "@/lib/db";
import { reverseGeocode, getElevation, generateSlug, inferTags } from "@/lib/geocoding";
import { logError } from "@/lib/observability";
import { generateProvinceSlug } from "@/lib/countries";

/**
 * Maximum distance (km) to search for a same-country match when a
 * closer location exists in a different country. Prevents sending a
 * user 200km away just because no same-country location is nearby.
 */
const COUNTRY_PREFERENCE_MAX_KM = 50;

/**
 * GET /api/geo?lat=-17.83&lon=31.05&autoCreate=true
 *
 * Given a lat/lon, return the nearest location from MongoDB.
 * Prefers same-country matches to respect political boundaries
 * (e.g. Woodlands, Singapore should match Singapore, not Johor Bahru).
 * If autoCreate=true and no nearby location exists in a supported region,
 * reverse geocode and auto-create one.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const lat = parseFloat(searchParams.get("lat") ?? "");
  const lon = parseFloat(searchParams.get("lon") ?? "");
  const autoCreate = searchParams.get("autoCreate") === "true";

  if (isNaN(lat) || isNaN(lon)) {
    return NextResponse.json({ error: "Missing or invalid lat/lon" }, { status: 400 });
  }

  try {
    // Fetch top candidates + user's country in parallel.
    // reverseGeocode is fast (~200ms) and runs concurrently with the DB query.
    const [results, geocoded] = await Promise.all([
      findNearestLocationsFromDb(lat, lon, { limit: 5, maxDistanceKm: COUNTRY_PREFERENCE_MAX_KM }),
      reverseGeocode(lat, lon),
    ]);

    let nearest = pickBestMatch(results, geocoded?.country ?? null);

    // If no location within the preference radius, try uncapped nearest
    // so users far from any seed location still get a result instead of 404.
    if (!nearest) {
      const uncapped = await findNearestLocationsFromDb(lat, lon, { limit: 1 });
      nearest = uncapped[0] ?? null;
    }

    if (nearest) {
      return NextResponse.json({
        nearest,
        redirectTo: `/${nearest.slug}`,
        isNew: false,
      });
    }

    // No nearby location found — check if in a supported region
    if (!(await isInSupportedRegionFromDb(lat, lon))) {
      return NextResponse.json(
        { error: "Location is outside supported regions", nearest: null },
        { status: 404 },
      );
    }

    // Auto-create if requested (reuse geocoded from the parallel call above)
    if (autoCreate) {
      if (!geocoded) {
        return NextResponse.json(
          { error: "Could not determine location name", nearest: null },
          { status: 422 },
        );
      }

      // Double-check for duplicates (race condition protection)
      const duplicate = await findDuplicateLocation(lat, lon, 20);
      if (duplicate) {
        return NextResponse.json({
          nearest: duplicate,
          redirectTo: `/${duplicate.slug}`,
          isNew: false,
        });
      }

      let elevation = geocoded.elevation;
      if (!elevation || elevation === 0) {
        elevation = await getElevation(lat, lon);
      }

      const slug = generateSlug(geocoded.name, geocoded.country);
      const province = geocoded.admin1 || geocoded.countryName;
      const provinceSlug = generateProvinceSlug(province, geocoded.country);

      // Upsert country and province for hierarchy pages.
      // Look up the region from MongoDB so $setOnInsert preserves curated data.
      const dbCountry = await getCountryByCode(geocoded.country).catch(() => null);
      await Promise.all([
        upsertCountry({ code: geocoded.country, name: geocoded.countryName, region: dbCountry?.region ?? "Unknown", supported: true }),
        upsertProvince({ slug: provinceSlug, name: province, countryCode: geocoded.country }),
      ]);

      const newLocation = await createLocation({
        slug,
        name: geocoded.name,
        province,
        lat: geocoded.lat,
        lon: geocoded.lon,
        elevation: Math.round(elevation),
        tags: await inferTags(geocoded),
        country: geocoded.country,
        source: "geolocation",
        provinceSlug,
      });

      return NextResponse.json({
        nearest: newLocation,
        redirectTo: `/${newLocation.slug}`,
        isNew: true,
      });
    }

    // Not auto-creating — return 404
    return NextResponse.json(
      { error: "No nearby location found. Use autoCreate=true to add one.", nearest: null },
      { status: 404 },
    );
  } catch (err) {
    logError({
      source: "mongodb",
      severity: "high",
      message: "Geo API query failed",
      error: err,
      meta: { lat, lon },
    });
    return NextResponse.json(
      { error: "Location service unavailable" },
      { status: 503 },
    );
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Pick the best location match from a list of candidates.
 *
 * Strategy: If the user's country is known and a same-country location
 * exists in the candidate list, prefer it over a closer cross-border
 * location. This handles border areas like Woodlands (SG) near
 * Johor Bahru (MY), where the nearest location by distance is in a
 * different country.
 *
 * Candidates are already sorted by distance (nearest first) from the
 * MongoDB $near query, so the first same-country match is the closest
 * one within that country.
 */
function pickBestMatch<T extends { country?: string }>(
  candidates: T[],
  userCountry: string | null,
): T | null {
  if (candidates.length === 0) return null;
  if (!userCountry) return candidates[0];

  const uc = userCountry.toUpperCase();
  const sameCountry = candidates.find(
    (loc) => (loc.country ?? "ZW").toUpperCase() === uc,
  );

  return sameCountry ?? candidates[0];
}
