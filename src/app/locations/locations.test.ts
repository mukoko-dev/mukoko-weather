/**
 * Locations list (`/locations`) — route contract, layout, the sky token
 * contrast guard, and the shared route-name sets.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { cardTheme, type OryxSky } from "@/lib/location-card";

const pageSource = readFileSync(resolve(__dirname, "page.tsx"), "utf-8");
const clientSource = readFileSync(
  resolve(__dirname, "LocationsClient.tsx"),
  "utf-8",
);
const loadingSource = readFileSync(resolve(__dirname, "loading.tsx"), "utf-8");
const css = readFileSync(resolve(__dirname, "../globals.css"), "utf-8");
const proxySource = readFileSync(resolve(__dirname, "../../proxy.ts"), "utf-8");
const loadingSceneSource = readFileSync(
  resolve(__dirname, "../../components/weather/WeatherLoadingScene.tsx"),
  "utf-8",
);
const slugHelpers = readFileSync(
  resolve(__dirname, "../../lib/current-slug.ts"),
  "utf-8",
);

describe("locations page — route contract", () => {
  it("is kept out of the index with noindex, nofollow", () => {
    expect(pageSource).toMatch(
      /robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/,
    );
  });

  it("declares its canonical URL", () => {
    expect(pageSource).toContain("canonical: `${BASE_URL}/locations`");
  });

  it("seeds My Location from the lastLocation cookie on the server", () => {
    expect(pageSource).toContain("cookies()");
    expect(pageSource).toContain('jar.get("lastLocation")');
    expect(pageSource).toContain("isLocationSlug(remembered)");
  });

  it("wraps the list in the shared header, footer and main landmark", () => {
    expect(pageSource).toContain("<Header />");
    expect(pageSource).toContain("<Footer />");
    expect(pageSource).toContain('id="main-content"');
  });
});

describe("locations list — client", () => {
  it("has the Weather h1 and a labelled list of cards", () => {
    expect(clientSource).toContain("<h1");
    expect(clientSource).toContain("Weather");
    expect(clientSource).toContain('aria-label="Locations"');
  });

  it("opens My Weather on the Location tab from the search bar", () => {
    expect(clientSource).toContain('openMyWeather("location")');
    expect(clientSource).toContain("Search for a city or airport");
  });

  it("caps saved places with the store limit and builds the list via the helper", () => {
    expect(clientSource).toContain("MAX_SAVED_LOCATIONS");
    expect(clientSource).toContain("buildLocationList(");
  });

  it("offers Set as Home and Remove through each card's menu", () => {
    expect(clientSource).toContain("Set as Home");
    expect(clientSource).toContain("Remove Home");
    expect(clientSource).toContain("removeLocation(entry.slug)");
    expect(clientSource).toContain("setHomeLocation(");
  });

  it("shows the search hint when nothing is saved", () => {
    expect(clientSource).toContain("Search to add places");
  });

  it("fetches each place's weather from the Python weather endpoint", () => {
    expect(clientSource).toContain("/api/py/weather?lat=");
  });

  it("uses the global styles only (no inline styles or hardcoded colours)", () => {
    expect(clientSource).not.toMatch(/style=\{\{/);
    expect(clientSource).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe("locations loading state", () => {
  it("announces loading with role=status and aria-label=Loading", () => {
    expect(loadingSource).toMatch(/role="status"\s+aria-label="Loading"/);
  });
});

describe("route names — locations is not a location slug", () => {
  it("proxy.ts treats /locations as an app route", () => {
    expect(proxySource).toMatch(/KNOWN_ROUTES[\s\S]*"locations"/);
  });

  it("WeatherLoadingScene treats /locations as an app route", () => {
    expect(loadingSceneSource).toMatch(/KNOWN_ROUTES[\s\S]*"locations"/);
  });

  it("current-slug.ts treats /locations as an app route", () => {
    expect(slugHelpers).toMatch(/NON_LOCATION_ROUTES[\s\S]*"locations"/);
  });
});

// ---------------------------------------------------------------------------
// Sky tokens — readable white text on every stop, in both themes
// ---------------------------------------------------------------------------

function block(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `${selector} block present`).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

function tokenValue(body: string, name: string): string {
  const m = body.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6});`));
  expect(m, `--${name} defined as a 6-digit hex`).not.toBeNull();
  return m![1];
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const r = lin(parseInt(h.slice(0, 2), 16));
  const g = lin(parseInt(h.slice(2, 4), 16));
  const b = lin(parseInt(h.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastWithWhite(hex: string): number {
  return 1.05 / (luminance(hex) + 0.05);
}

const SKY_NAMES = [
  "clear-day",
  "clear-night",
  "cloudy",
  "rain",
  "storm",
  "fog",
  "snow",
] as const;

describe("oryx sky tokens", () => {
  const root = block(":root {\n  --color-oryx-fg");
  const dark = block('[data-theme="dark"] {\n  --oryx-star');

  it("defines every sky stop in :root and in the dark theme", () => {
    for (const name of SKY_NAMES) {
      for (const stop of ["top", "bottom"]) {
        expect(root).toContain(`--oryx-${name}-${stop}:`);
        expect(dark).toContain(`--oryx-${name}-${stop}:`);
      }
    }
  });

  it("keeps white text at >= 4.5:1 on every stop, light and dark", () => {
    for (const body of [root, dark]) {
      for (const name of SKY_NAMES) {
        for (const stop of ["top", "bottom"]) {
          const hex = tokenValue(body, `oryx-${name}-${stop}`);
          expect(
            contrastWithWhite(hex),
            `${name} ${stop} ${hex}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("defines the .oryx-* class for every sky cardTheme can return", () => {
    const codes = [0, 1, 2, 3, 45, 48, 51, 57, 63, 67, 71, 77, 81, 86, 95, 99];
    const skies = new Set<OryxSky>();
    for (const code of codes) {
      skies.add(cardTheme(code, true));
      skies.add(cardTheme(code, false));
    }
    for (const sky of skies) {
      expect(css).toContain(`.${sky} {`);
    }
  });

  it("defines the shared .oryx card surface and its text token", () => {
    expect(css).toContain("  .oryx {");
    expect(root).toContain("--color-oryx-fg: #ffffff;");
  });
});
