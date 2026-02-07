import { Hono } from "hono";
import type { Env } from "../types";
import { LOCATIONS, TAG_LABELS, type LocationTag } from "../data/locations";

export const locationRoutes = new Hono<{ Bindings: Env }>();

// GET /api/locations — all locations
locationRoutes.get("/", (c) => {
  return c.json({
    count: LOCATIONS.length,
    tags: TAG_LABELS,
    locations: LOCATIONS,
  }, 200, { "Cache-Control": "public, max-age=86400" });
});

// GET /api/locations/:tag — filtered by tag
locationRoutes.get("/:tag", (c) => {
  const tag = c.req.param("tag") as LocationTag;
  if (!(tag in TAG_LABELS)) {
    return c.json({ error: `Unknown tag: ${tag}`, validTags: Object.keys(TAG_LABELS) }, 400);
  }

  const filtered = LOCATIONS.filter((l) => l.tags.includes(tag));
  return c.json({
    tag,
    label: TAG_LABELS[tag],
    count: filtered.length,
    locations: filtered,
  }, 200, { "Cache-Control": "public, max-age=86400" });
});
