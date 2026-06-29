import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const plannerSrc = readFileSync(resolve(__dirname, "AviationPlanner.tsx"), "utf-8");
const pdfSrc = readFileSync(resolve(__dirname, "AviationBriefingPDF.tsx"), "utf-8");
const pageSrc = readFileSync(resolve(__dirname, "page.tsx"), "utf-8");

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
  it("uses flight category badges", () => {
    expect(plannerSrc).toContain("FlightCategoryBadge");
    expect(plannerSrc).toContain("VFR");
    expect(plannerSrc).toContain("MVFR");
    expect(plannerSrc).toContain("IFR");
    expect(plannerSrc).toContain("LIFR");
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

  it("awaits requireUser() inside the page export", () => {
    expect(pageSrc).toContain("await requireUser()");
  });
});
