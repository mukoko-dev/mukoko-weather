/**
 * POST /api/locations/add
 *
 * Dynamically add locations without code deploys.
 *
 * Two modes:
 * 1. Coordinates: { lat, lon } → reverse geocode + dedupe + create
 * 2. Search:      { query }    → forward geocode + return candidates
 *
 * Rate limit: 5 creations per IP per hour.
 */

import { NextResponse, type NextRequest } from "next/server";
import { reverseGeocode, forwardGeocode, getElevation, generateSlug, inferTags } from "@/lib/geocoding";
import { isInSupportedRegion } from "@/lib/locations";
import { createLocation, findDuplicateLocation, getLocationFromDb } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { logError } from "@/lib/observability";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // ── Mode 1: Search (forward geocode) ──────────────────────────────
    if (body.query && typeof body.query === "string") {
      const results = await forwardGeocode(body.query.trim(), { count: 5 });

      // Filter to supported regions only
      const supported = results.filter((r) => isInSupportedRegion(r.lat, r.lon));

      return NextResponse.json({
        mode: "candidates",
        results: supported.map((r) => ({
          name: r.name,
          country: r.country,
          countryName: r.countryName,
          admin1: r.admin1,
          lat: r.lat,
          lon: r.lon,
          elevation: r.elevation,
        })),
      });
    }

    // ── Mode 2: Coordinates (reverse geocode + create) ────────────────
    const lat = Number(body.lat);
    const lon = Number(body.lon);

    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return NextResponse.json(
        { error: "Invalid coordinates. Provide valid lat and lon." },
        { status: 400 },
      );
    }

    // Check supported region
    if (!isInSupportedRegion(lat, lon)) {
      return NextResponse.json(
        { error: "Coordinates are outside supported regions." },
        { status: 400 },
      );
    }

    // Rate limit
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const rateLimit = await checkRateLimit(ip, "location-create", 5, 3600);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Rate limit exceeded. Try again later.", resetAt: rateLimit.resetAt.toISOString() },
        { status: 429 },
      );
    }

    // Check for duplicates within 20km (city-level dedup)
    const duplicate = await findDuplicateLocation(lat, lon, 20);
    if (duplicate) {
      return NextResponse.json({
        mode: "duplicate",
        existing: {
          slug: duplicate.slug,
          name: duplicate.name,
          province: duplicate.province,
          country: duplicate.country ?? "ZW",
        },
        message: `A location already exists nearby: ${duplicate.name}`,
      });
    }

    // Reverse geocode
    const geocoded = await reverseGeocode(lat, lon);
    if (!geocoded) {
      return NextResponse.json(
        { error: "Could not determine location name for these coordinates." },
        { status: 422 },
      );
    }

    // Get elevation if not provided by geocoder
    let elevation = geocoded.elevation;
    if (!elevation || elevation === 0) {
      elevation = await getElevation(lat, lon);
    }

    // Generate slug
    let slug = generateSlug(geocoded.name, geocoded.country);

    // Handle slug collisions
    const existingSlug = await getLocationFromDb(slug);
    if (existingSlug) {
      // Append a numeric suffix
      let suffix = 2;
      while (await getLocationFromDb(`${slug}-${suffix}`)) {
        suffix++;
      }
      slug = `${slug}-${suffix}`;
    }

    // Create location
    const newLocation = await createLocation({
      slug,
      name: geocoded.name,
      province: geocoded.admin1 || geocoded.countryName,
      lat: geocoded.lat,
      lon: geocoded.lon,
      elevation: Math.round(elevation),
      tags: await inferTags(geocoded),
      country: geocoded.country,
      source: "community",
    });

    return NextResponse.json({
      mode: "created",
      location: {
        slug: newLocation.slug,
        name: newLocation.name,
        province: newLocation.province,
        country: newLocation.country ?? geocoded.country,
        lat: newLocation.lat,
        lon: newLocation.lon,
        elevation: newLocation.elevation,
      },
    });
  } catch (err) {
    logError({
      source: "mongodb",
      severity: "medium",
      message: "Failed to add location",
      error: err,
    });
    return NextResponse.json(
      { error: "Failed to add location" },
      { status: 500 },
    );
  }
}
