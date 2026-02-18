import { NextRequest, NextResponse } from "next/server";
import { findNearestLocationsFromDb, createLocation, findDuplicateLocation } from "@/lib/db";
import { isInSupportedRegion } from "@/lib/locations";
import { reverseGeocode, getElevation, generateSlug, inferTags } from "@/lib/geocoding";
import { logError } from "@/lib/observability";

/**
 * GET /api/geo?lat=-17.83&lon=31.05&autoCreate=true
 *
 * Given a lat/lon, return the nearest location from MongoDB.
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
    const results = await findNearestLocationsFromDb(lat, lon, { limit: 1 });
    const nearest = results[0] ?? null;

    if (nearest) {
      return NextResponse.json({
        nearest,
        redirectTo: `/${nearest.slug}`,
        isNew: false,
      });
    }

    // No nearby location found — check if in a supported region
    if (!isInSupportedRegion(lat, lon)) {
      return NextResponse.json(
        { error: "Location is outside supported regions", nearest: null },
        { status: 404 },
      );
    }

    // Auto-create if requested
    if (autoCreate) {
      const geocoded = await reverseGeocode(lat, lon);
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
      const newLocation = await createLocation({
        slug,
        name: geocoded.name,
        province: geocoded.admin1 || geocoded.countryName,
        lat: geocoded.lat,
        lon: geocoded.lon,
        elevation: Math.round(elevation),
        tags: await inferTags(geocoded),
        country: geocoded.country,
        source: "geolocation",
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
