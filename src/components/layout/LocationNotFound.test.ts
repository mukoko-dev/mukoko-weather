/**
 * LocationNotFound is the site-wide 404 (rendered by the root not-found.tsx
 * as well as `[location]/not-found.tsx`), so it must carry the page landmark
 * and the root layout's skip-link target like every other page.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(__dirname, "LocationNotFound.tsx"),
  "utf-8",
);

describe("LocationNotFound", () => {
  it('renders a <main id="main-content"> landmark (skip-link target)', () => {
    expect(source).toMatch(/<main[\s\S]*?id="main-content"/);
    expect(source).toContain("</main>");
  });

  it("labels the landmark with its heading", () => {
    expect(source).toContain('aria-labelledby="not-found-heading"');
    expect(source).toMatch(/<h1[\s\S]*?id="not-found-heading"/);
  });

  it("is the root 404 too", () => {
    const root = readFileSync(
      resolve(__dirname, "../../app/not-found.tsx"),
      "utf-8",
    );
    expect(root).toContain("LocationNotFound");
  });
});
