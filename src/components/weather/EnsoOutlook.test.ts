/**
 * Tests for EnsoOutlook — validates the card's data flow, accessibility
 * wiring, copy, and location-page integration by reading the source files
 * (Vitest runs in Node without a DOM/React renderer).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  formatOni,
  ENSO_PHASE_CLASS,
  ENSO_STRENGTH_LABEL,
} from "./EnsoOutlook";

const source = readFileSync(resolve(__dirname, "EnsoOutlook.tsx"), "utf-8");
const skeletonSource = readFileSync(
  resolve(__dirname, "SectionSkeleton.tsx"),
  "utf-8",
);
const dashboardSource = readFileSync(
  resolve(__dirname, "../../app/[location]/WeatherDashboard.tsx"),
  "utf-8",
);
const storeSource = readFileSync(
  resolve(__dirname, "../../lib/store.ts"),
  "utf-8",
);

describe("EnsoOutlook — client component", () => {
  it("is a client component with 'use client' directive", () => {
    expect(source).toContain('"use client"');
  });

  it("exports EnsoOutlook as a named function", () => {
    expect(source).toContain("export function EnsoOutlook");
  });

  it("fetches the Python ENSO endpoint", () => {
    expect(source).toContain('"/api/py/enso"');
  });

  it("aborts the in-flight request on unmount", () => {
    expect(source).toContain("new AbortController()");
    expect(source).toContain("controller.abort()");
  });

  it("ignores AbortError and post-unmount responses", () => {
    expect(source).toContain("AbortError");
    expect(source).toContain("if (cancelled) return;");
  });

  it("renders nothing when the outlook is unavailable", () => {
    expect(source).toContain(
      'if (state.status === "unavailable") return null;',
    );
  });

  it("shows the skeleton while loading", () => {
    expect(source).toContain(
      'if (state.status === "loading") return <EnsoOutlookSkeleton />;',
    );
  });
});

describe("EnsoOutlook — accessibility", () => {
  it("labels the section with a heading id via aria-labelledby", () => {
    expect(source).toContain("useId()");
    expect(source).toContain("aria-labelledby={headingId}");
    expect(source).toContain("headingId={headingId}");
  });

  it("uses the shared SectionHeader for the heading", () => {
    expect(source).toContain(
      'import { SectionHeader } from "@/components/ui/section-header"',
    );
    expect(source).toContain('title="El Niño / La Niña outlook"');
  });

  it("labels the recent-seasons list", () => {
    expect(source).toContain('aria-label="Recent seasons"');
  });
});

describe("EnsoOutlook — content and attribution", () => {
  it("shows the attribution and the seasonal-not-daily disclaimer", () => {
    expect(source).toContain("Seasonal outlook, not a forecast for today.");
    expect(source).toContain("Source: {data.source}.");
  });

  it("falls back to the NOAA CPC ONI source label from the API payload", () => {
    expect(source).toContain("source: string;");
    expect(
      readFileSync(resolve(__dirname, "../../../api/py/_enso.py"), "utf-8"),
    ).toContain('SOURCE_LABEL = "NOAA CPC ONI"');
  });

  it("renders impact lines from the ensoImpact helper", () => {
    expect(source).toContain(
      'import { ensoImpact, type EnsoPhase } from "@/lib/enso"',
    );
    expect(source).toContain("ensoImpact(data.phase, countryCode, lat, lon)");
  });

  it("shows the ONI value together with its season", () => {
    expect(source).toContain(
      "ONI {formatOni(data.oni)} for {data.season} {data.year}",
    );
  });

  it("maps every phase and strength to a label", () => {
    for (const phase of ["El Niño", "La Niña", "Neutral"]) {
      expect(ENSO_PHASE_CLASS).toHaveProperty(phase);
    }
    for (const strength of ["weak", "moderate", "strong", "very strong"]) {
      expect(ENSO_STRENGTH_LABEL).toHaveProperty(strength);
    }
  });
});

describe("EnsoOutlook — styling rules", () => {
  it("uses only semantic token classes, never hardcoded colours or inline styles", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(source).not.toMatch(/rgba?\(/);
    expect(source).not.toMatch(/style=\{\{/);
    expect(source).not.toMatch(
      /\b(text|bg|border)-(red|green|amber|blue|yellow|orange)-\d/,
    );
  });

  it("uses severity and surface tokens for phase badges", () => {
    expect(ENSO_PHASE_CLASS["El Niño"]).toContain("bg-severity-moderate");
    expect(ENSO_PHASE_CLASS["La Niña"]).toContain("bg-severity-cold");
    expect(ENSO_PHASE_CLASS["El Niño"]).toContain("text-severity-fg");
  });

  it("uses fauna classes for the card and its text (heading class comes from SectionHeader)", () => {
    // Card padding comes from the .baobab token (--space-card), not overrides.
    expect(source).toContain('className="baobab"');
    expect(source).toContain("dove");
    expect(source).toContain("gazelle");
  });
});

describe("formatOni", () => {
  it("prefixes positive values with +", () => {
    expect(formatOni(2.16)).toBe("+2.16");
    expect(formatOni(0)).toBe("+0.00");
  });

  it("uses a typographic minus for negative values", () => {
    expect(formatOni(-0.43)).toBe("−0.43");
  });

  it("always shows two decimals", () => {
    expect(formatOni(1.8)).toBe("+1.80");
  });
});

describe("SectionSkeleton — EnsoOutlookSkeleton", () => {
  it("exports EnsoOutlookSkeleton", () => {
    expect(skeletonSource).toContain("export function EnsoOutlookSkeleton");
  });

  it("announces itself as a loading status", () => {
    const start = skeletonSource.indexOf("export function EnsoOutlookSkeleton");
    const block = skeletonSource.slice(start);
    expect(block).toContain('role="status"');
    expect(block).toContain('aria-label="Loading"');
  });
});

describe("WeatherDashboard — EnsoOutlook wiring", () => {
  it("imports EnsoOutlook and its skeleton", () => {
    expect(dashboardSource).toContain(
      'import { EnsoOutlook } from "@/components/weather/EnsoOutlook"',
    );
    expect(dashboardSource).toContain("EnsoOutlookSkeleton,");
  });

  it("renders the card inside DraggableSection, LazySection and ChartErrorBoundary", () => {
    const start = dashboardSource.indexOf('case "enso":');
    expect(start).toBeGreaterThan(-1);
    const block = dashboardSource.slice(start, start + 1200);
    expect(block).toContain("<DraggableSection");
    expect(block).toContain("<LazySection");
    expect(block).toContain('<ChartErrorBoundary name="ENSO outlook">');
    expect(block).toContain("<Suspense");
    expect(block).toContain("<EnsoOutlook");
    expect(block).toContain("lon={location.lon}");
    expect(block).toContain("countryCode={location.country}");
  });

  it("is part of the default section order, after the AI follow-up chat", () => {
    expect(storeSource).toMatch(/"aiChat",\s*"enso",\s*\] as const/);
  });
});
