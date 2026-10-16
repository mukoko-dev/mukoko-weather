/**
 * MapPreview (#266): the static, non-interactive map card on the location
 * page. Rendered for real (react-dom/server) rather than grepped, so these
 * check what a visitor's HTML actually contains: the tiles, the credits and
 * the link structure.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WeatherLocation } from "@/lib/locations";

const theme = vi.hoisted(() => ({ dark: false }));
vi.mock("./use-map-style", () => ({ useMapIsDark: () => theme.dark }));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: unknown;
  } & Record<string, unknown>) =>
    createElement("a", { href, ...rest }, children as never),
}));

const harare: WeatherLocation = {
  slug: "harare",
  name: "Harare",
  province: "Harare",
  lat: -17.8292,
  lon: 31.0522,
  elevation: 1490,
  tags: ["city"],
  country: "ZW",
};

async function render(opts: { key?: string; dark?: boolean } = {}) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_MAPTILER_API_KEY", opts.key ?? "test-key\n");
  theme.dark = opts.dark ?? false;
  const { MapPreview } = await import("./MapPreview");
  const { attributionForLayer } = await import("@/lib/map-sources");
  return {
    html: renderToStaticMarkup(createElement(MapPreview, { location: harare })),
    credits: attributionForLayer(null),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("MapPreview", () => {
  it("draws four MapTiler raster tiles with the trimmed key and no map library", async () => {
    const { html } = await render();
    const tiles = [...html.matchAll(/<image[^>]*href="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(tiles).toHaveLength(4);
    for (const href of tiles) {
      expect(href).toMatch(
        /^https:\/\/api\.maptiler\.com\/maps\/streets-v2\/10\/\d+\/\d+\.png\?key=test-key$/,
      );
    }
    // Overlap hides the hairline seam between tiles.
    expect(html).toContain('width="513"');
    expect(html).not.toMatch(/maplibre/i);
  });

  it("follows the theme", async () => {
    const { html } = await render({ dark: true });
    expect(html).toContain("/maps/streets-v2-dark/10/");
    expect(html).not.toContain("/maps/streets-v2/10/");
  });

  it("credits come from map-sources, one linked entry per base-map provider", async () => {
    const { html, credits } = await render();
    expect(credits.map((c) => c.id)).toEqual(["maptiler", "osm"]);
    for (const p of credits) {
      expect(html).toContain(`href="${p.href}"`);
      expect(html).toContain(p.label);
    }
  });

  it("keeps the credit links out of the map link (no nested anchors)", async () => {
    const { html, credits } = await render();
    const mapLink = html.match(
      /<a [^>]*aria-label="Open weather map for Harare"[^>]*>([\s\S]*?)<\/a>/,
    );
    expect(mapLink).not.toBeNull();
    expect(mapLink![1]).not.toContain("<a ");
    for (const p of credits) expect(mapLink![1]).not.toContain(p.label);
    // ...and they are still on the page, after it.
    expect(html.indexOf(credits[0].label)).toBeGreaterThan(
      html.indexOf("</a>", html.indexOf("Open weather map")),
    );
  });

  it("links to the full map and hides the decorative picture from assistive tech", async () => {
    const { html } = await render();
    expect(html).toContain('href="/harare/map"');
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(html).toContain('aria-labelledby="map-preview-heading"');
  });

  it("without a key shows the text fallback, no tiles and no MapTiler credit", async () => {
    const { html, credits } = await render({ key: "  \n" });
    expect(html).not.toContain("<image");
    expect(html).toContain("Open the weather map");
    expect(html).toContain('href="/harare/map"');
    expect(html).not.toContain(credits[0].label);
  });

  it("uses tokens, not hardcoded colours or inline styles", async () => {
    const { html } = await render();
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toContain("style=");
    expect(html).toContain("fill-primary");
  });
});
