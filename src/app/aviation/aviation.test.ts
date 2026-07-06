import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const plannerSrc = readFileSync(resolve(__dirname, "AviationPlanner.tsx"), "utf-8");
const pdfSrc = readFileSync(resolve(__dirname, "AviationBriefingPDF.tsx"), "utf-8");
const pageSrc = readFileSync(resolve(__dirname, "page.tsx"), "utf-8");
const errorSrc = readFileSync(resolve(__dirname, "error.tsx"), "utf-8");
const loadingSrc = readFileSync(resolve(__dirname, "loading.tsx"), "utf-8");

describe("AviationPlanner", () => {
  it("is a client component", () => {
    expect(plannerSrc).toContain('"use client"');
  });
  it("exports AviationPlanner", () => {
    expect(plannerSrc).toContain("export function AviationPlanner");
  });
  it("has departure and destination search", () => {
    expect(plannerSrc).toContain("Departure Airport");
    expect(plannerSrc).toContain("Destination Airport");
  });
  it("has Get Briefing button", () => {
    expect(plannerSrc).toContain("Get Briefing");
  });
  it("has PDF download", () => {
    expect(plannerSrc).toContain("Download PDF Briefing");
    expect(plannerSrc).toContain("@react-pdf/renderer");
  });
  it("uses flight category badges via the shared flight-category-styles module", () => {
    // VFR/MVFR/IFR/LIFR color mapping is centralized in
    // @/lib/flight-category-styles (shared with AviationWeather) so it can't
    // drift between the two — see flight-category-styles.test.ts for the
    // category list and color-mapping assertions.
    expect(plannerSrc).toContain("FlightCategoryBadge");
    expect(plannerSrc).toContain("getFlightCategoryClass");
    expect(plannerSrc).toContain("@/lib/flight-category-styles");
  });
  it("fetches METAR from API", () => {
    expect(plannerSrc).toContain("/api/py/metar");
  });
  it("has accessibility main landmark", () => {
    expect(plannerSrc).toContain('id="main-content"');
  });
  it("has alternate airport option", () => {
    expect(plannerSrc).toContain("Alternate Airport");
    expect(plannerSrc).toContain("alternate");
  });
});

describe("AviationPlanner — Harare-bug fixes", () => {
  it("resolves airport coordinates for the weather fetch (not a slug/location param)", () => {
    expect(plannerSrc).toContain("getAirportByIcao");
    // The weather endpoint takes lat/lon ONLY — a `location=` param is ignored
    // and silently defaults to Harare, so it must never be used here.
    expect(plannerSrc).toContain("/api/py/weather?lat=");
    expect(plannerSrc).not.toContain("/api/py/weather?location=");
  });

  it("reads daily from the top level of the weather response, not d.weather.daily", () => {
    expect(plannerSrc).toContain("const daily = d.daily");
    expect(plannerSrc).not.toContain("d.weather?.daily");
  });

  it("surfaces airport-search failures via the shared quick-search hook", () => {
    // Fetch failures, cancellation, and the loading flag are handled inside
    // useLocationQuickSearch (which clears loading in finally); this picker
    // only maps the hook's error flag to its message.
    expect(plannerSrc).toContain("useLocationQuickSearch({ limit: 8, minLength: 2 })");
    expect(plannerSrc).toContain("searchError");
  });
});

describe("Aviation error boundary", () => {
  it("is a client component", () => {
    expect(errorSrc).toContain('"use client"');
  });
  it("exports a default error component wrapping the shared RouteErrorBoundary", () => {
    expect(errorSrc).toContain("export default function AviationError");
    expect(errorSrc).toContain("RouteErrorBoundary");
    expect(errorSrc).toContain('source="aviation"');
  });
});

describe("Aviation loading boundary", () => {
  it("exports a default loading component", () => {
    expect(loadingSrc).toContain("export default function AviationLoading");
  });
  it("renders the Header and an accessible loading status", () => {
    expect(loadingSrc).toContain("Header");
    expect(loadingSrc).toContain('role="status"');
  });
});

describe("AviationBriefingPDF", () => {
  it("is a client component", () => {
    expect(pdfSrc).toContain('"use client"');
  });
  it("exports AviationBriefingPDF", () => {
    expect(pdfSrc).toContain("export function AviationBriefingPDF");
  });
  it("exports BriefingData type", () => {
    expect(pdfSrc).toContain("export interface BriefingData");
  });
  it("exports AirportBriefing type", () => {
    expect(pdfSrc).toContain("export interface AirportBriefing");
  });
  it("uses @react-pdf/renderer Document", () => {
    expect(pdfSrc).toContain("Document");
    expect(pdfSrc).toContain("Page");
    expect(pdfSrc).toContain("@react-pdf/renderer");
  });
  it("includes disclaimer text", () => {
    expect(pdfSrc).toContain("national aviation authority");
  });
  it("includes mukoko branding", () => {
    expect(pdfSrc).toContain("mukoko weather");
  });
  it("uses hex colors for PDF (not CSS variables)", () => {
    expect(pdfSrc).toContain("#1a2744");
    expect(pdfSrc).not.toContain("var(--");
  });
});

describe("Aviation page", () => {
  it("is NOT a client component", () => {
    expect(pageSrc).not.toContain('"use client"');
  });
  it("exports default page component (now async for auth gating)", () => {
    expect(pageSrc).toContain("export default async function AviationPage");
  });
  it("has metadata", () => {
    expect(pageSrc).toContain("export const metadata");
    expect(pageSrc).toContain("Aviation Weather Briefing");
  });
  it("renders Header and Footer", () => {
    expect(pageSrc).toContain("Header");
    expect(pageSrc).toContain("Footer");
  });
  it("renders AviationPlanner", () => {
    expect(pageSrc).toContain("AviationPlanner");
  });
});

describe("Aviation page — auth gating (Phase 1D)", () => {
  it("imports requireUser from the auth helper", () => {
    expect(pageSrc).toContain("requireUser");
    expect(pageSrc).toContain("@/lib/auth");
  });

  it("awaits requireUser() inside the page export, passing its own path as returnTo", () => {
    expect(pageSrc).toContain('await requireUser("/aviation")');
  });
});
