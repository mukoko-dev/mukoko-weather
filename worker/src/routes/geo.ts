import { Hono } from "hono";
import type { Env } from "../types";
import { findNearestLocation } from "../data/locations";

export const geoRoutes = new Hono<{ Bindings: Env }>();

geoRoutes.get("/", (c) => {
  const lat = parseFloat(c.req.query("lat") ?? "");
  const lon = parseFloat(c.req.query("lon") ?? "");

  if (isNaN(lat) || isNaN(lon)) {
    return c.json({ error: "Missing or invalid lat/lon" }, 400);
  }

  const nearest = findNearestLocation(lat, lon);

  if (!nearest) {
    return c.json({ error: "Location appears to be outside Zimbabwe", nearest: null }, 404);
  }

  return c.json({ nearest, redirectTo: `/${nearest.slug}` });
});
