/**
 * LocationWeatherCard — structure and accessibility contract, checked against
 * the source (Vitest runs in Node; the card's behaviour is covered by
 * location-card.test.ts for its logic).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "LocationWeatherCard.tsx"),
  "utf-8",
);

describe("LocationWeatherCard — structure", () => {
  it("is a client component exporting LocationWeatherCard", () => {
    expect(source.startsWith('"use client"')).toBe(true);
    expect(source).toContain("export function LocationWeatherCard");
  });

  it("renders the ready card as one link named by accessibleName", () => {
    expect(source).toMatch(/<Link\s[^>]*aria-label=\{accessibleName\}/);
  });

  it("paints the condition sky through the oryx fauna class", () => {
    expect(source).toContain("`oryx ${summary.sky}");
  });

  it("uses the oryx card surface and white-on-sky text tokens only", () => {
    expect(source).toContain("text-[var(--color-oryx-fg)]");
  });
});

describe("LocationWeatherCard — loading and error states", () => {
  it("shows a same-size skeleton with role=status and aria-label=Loading", () => {
    expect(source).toMatch(/role="status"\s+aria-label="Loading"/);
    expect(source).toContain('aria-busy="true"');
    expect(source).toContain("chameleon");
  });

  it("keeps the name visible and says weather is unavailable on error", () => {
    expect(source).toContain("Weather unavailable");
    expect(source).toContain("acacia");
  });
});

describe("LocationWeatherCard — menu", () => {
  it("is a disclosure button with a menu popup and an accessible label", () => {
    expect(source).toContain('aria-haspopup="menu"');
    expect(source).toContain("aria-expanded={menuOpen}");
    expect(source).toContain("More options for ${name}");
  });

  it("sits outside the link, never nested inside it", () => {
    // The ready branch closes the link before rendering the menu button.
    expect(source).toMatch(/<\/Link>\s*\{menuButton\}/);
  });

  it("closes on outside pointer-down and Escape", () => {
    expect(source).toContain('"pointerdown"');
    expect(source).toContain('event.key === "Escape"');
  });

  it("menu items are menuitem buttons inside role=menu", () => {
    expect(source).toContain('role="menu"');
    expect(source).toContain('role="menuitem"');
  });

  it("touch-sized trigger from the shared token", () => {
    expect(source).toContain("h-[var(--touch-target-min)]");
    expect(source).toContain("w-[var(--touch-target-min)]");
  });
});

describe("LocationWeatherCard — global styles only", () => {
  it("has no inline style objects", () => {
    expect(source).not.toMatch(/style=\{\{/);
  });

  it("has no hardcoded hex, rgb() or rgba() colours", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\brgba?\(/);
  });
});
