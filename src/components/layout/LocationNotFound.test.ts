/**
 * LocationNotFound is the site-wide 404 (rendered by the root not-found.tsx
 * as well as `[location]/not-found.tsx`). Its layout comes from NotFoundView,
 * which sits in PageShell, so it inherits the single <main id="main-content">
 * skip-link target and the mobile-nav bottom clearance. Its server HTML must
 * carry the landmark and the heading too (#263): visitors and crawlers
 * without JavaScript get them from the server render, not only after hydration.
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
  default: ({
    href,
    className,
    children,
  }: {
    href: string;
    className?: string;
    children: unknown;
  }) => createElement("a", { href, className }, children as never),
}));
// The client chrome (auth, store, router) is AppChrome's job; PageShell still
// renders its slots, so stub them here and keep the real PageShell <main>.
vi.mock("@/components/layout/Header", () => ({ Header: () => null }));
vi.mock("@/components/layout/Footer", () => ({ Footer: () => null }));
vi.mock("@/components/layout/HeaderSkeleton", () => ({
  HeaderSkeleton: () => null,
}));

const { LocationNotFound } = await import("./LocationNotFound");

const source = readFileSync(
  resolve(__dirname, "LocationNotFound.tsx"),
  "utf-8",
);
const viewSource = readFileSync(
  resolve(__dirname, "NotFoundView.tsx"),
  "utf-8",
);

describe("LocationNotFound", () => {
  it("lays out through the shared NotFoundView", () => {
    expect(source).toContain("NotFoundView");
    expect(source).not.toMatch(/<main[\s\S]*?id="main-content"/);
  });

  it("NotFoundView sits in PageShell and labels its section with the heading", () => {
    expect(viewSource).toContain("<PageShell");
    expect(viewSource).toContain('headingId = "not-found-heading"');
    expect(viewSource).toMatch(/aria-labelledby=\{headingId\}/);
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
  it("contains the main landmark, the labelled section and the not-found heading", async () => {
    mockLocations.mockResolvedValue([{ slug: "harare", name: "Harare" }]);
    const html = await serverHtml();
    expect(html).toMatch(/<main[^>]*id="main-content"/);
    expect(html).toMatch(/<section[^>]*aria-labelledby="not-found-heading"/);
    expect(html).toMatch(
      /<h1[^>]*id="not-found-heading"[^>]*>Location not found<\/h1>/,
    );
    expect(html).toContain('href="/harare"');
    expect(html).toMatch(/class="kudu"[^>]*>Browse locations/);
  });

  it("still renders the heading when the city list can't load", async () => {
    mockLocations.mockRejectedValue(new Error("mongo down"));
    const html = await serverHtml();
    expect(html).toContain(">Location not found</h1>");
    expect(html).not.toContain("Try one of these cities");
  });
});
