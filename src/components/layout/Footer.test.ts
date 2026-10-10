/**
 * Footer — source-level checks (Vitest runs in Node without a DOM renderer).
 * Covers the mobile touch-target audit: social icons and attribution links
 * are small inline controls and must carry the .dik-dik class.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "Footer.tsx"), "utf-8");

function linkBlock(marker: string): string {
  const idx = source.indexOf(marker);
  expect(idx).toBeGreaterThan(-1);
  return source.slice(idx, idx + 260);
}

describe("Footer touch targets", () => {
  it("Twitter and GitHub icon links carry .dik-dik", () => {
    expect(linkBlock('aria-label="Twitter"')).toContain("dik-dik");
    expect(linkBlock('aria-label="GitHub"')).toContain("dik-dik");
  });

  it("credits every forecast model provider (issue #246, CC BY 4.0)", () => {
    expect(source).toContain(
      "Weather data: ECMWF, NOAA, DWD, ECCC, Météo-France via",
    );
    expect(source).toContain("Open-Meteo.com");
    expect(source).toContain(
      'href="https://creativecommons.org/licenses/by/4.0/"',
    );
    expect(source).toContain("insights enrichment by");
  });

  it("Tomorrow.io and Open-Meteo attribution links carry .dik-dik", () => {
    expect(linkBlock('href="https://www.tomorrow.io"')).toContain("dik-dik");
    expect(linkBlock('href="https://open-meteo.com"')).toContain("dik-dik");
  });

  it("keeps the footer contentinfo landmark", () => {
    expect(source).toContain('role="contentinfo"');
  });
});
