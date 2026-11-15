// The Rust Worker's route table (workers/web/routing/routes.json) and this
// app's own route list (src/lib/routes.ts) say which pages the build serves.
// They must agree, or the Worker would serve a page the shell links to as a
// full page load (or the other way round).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PREVIEW_ROUTES, SERVED_ROUTES } from "~/lib/routes";

const table = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../workers/web/routing/routes.json", import.meta.url),
    ),
    "utf8",
  ),
) as {
  routes: { pattern: string; status: string }[];
  astro_only: { pattern: string }[];
};

describe("workers/web route table", () => {
  it("lists as migrated exactly the routes this app serves", () => {
    const migrated = table.routes
      .filter((r) => r.status === "migrated")
      .map((r) => r.pattern)
      .sort();
    expect(migrated).toEqual([...SERVED_ROUTES].sort());
  });

  it("lists as astro-only exactly the preview pages", () => {
    expect(table.astro_only.map((r) => r.pattern).sort()).toEqual(
      [...PREVIEW_ROUTES].sort(),
    );
  });
});
