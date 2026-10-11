/**
 * LocationNotFound is the site-wide 404 (rendered by the root not-found.tsx
 * as well as `[location]/not-found.tsx`), so it must carry the page landmark
 * and the root layout's skip-link target like every other page. Its server
 * HTML must contain them too (#263): visitors and crawlers without
 * JavaScript get the landmark and the heading from the server render, not
 * only after hydration.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mockLocations = vi.fn();
vi.mock("@/lib/db", () => ({
  getLocationsForContext: () => mockLocations(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) =>
    createElement("a", { href }, children as never),
}));

const { LocationNotFound } = await import("./LocationNotFound");

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

async function serverHtml(): Promise<string> {
  return renderToStaticMarkup((await LocationNotFound()) as ReactElement);
}

describe("LocationNotFound — server-rendered HTML", () => {
  it("contains the main landmark and the not-found heading", async () => {
    mockLocations.mockResolvedValue([{ slug: "harare", name: "Harare" }]);
    const html = await serverHtml();
    expect(html).toMatch(
      /<main[^>]*id="main-content"[^>]*aria-labelledby="not-found-heading"/,
    );
    expect(html).toMatch(
      /<h1[^>]*id="not-found-heading"[^>]*>Location not found<\/h1>/,
    );
    expect(html).toContain('href="/harare"');
  });

  it("still renders the heading when the city list can't load", async () => {
    mockLocations.mockRejectedValue(new Error("mongo down"));
    const html = await serverHtml();
    expect(html).toContain(">Location not found</h1>");
    expect(html).not.toContain("Try one of these cities");
  });
});
