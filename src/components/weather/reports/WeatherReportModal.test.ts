import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "WeatherReportModal.tsx"), "utf-8");

/**
 * WeatherReportModal component tests.
 *
 * Tests the 3-step report submission wizard: select type, clarify, confirm.
 */

describe("WeatherReportModal structure", () => {
  it("is a client component", () => {
    expect(source).toContain('"use client"');
  });

  it("exports WeatherReportModal", () => {
    expect(source).toContain("export function WeatherReportModal");
  });

  it("uses shadcn Dialog with sheet handle", () => {
    expect(source).toContain("<Dialog");
    expect(source).toContain("DialogContent");
    expect(source).toContain("DialogSheetHandle");
  });

  it("reads reportModalOpen from store", () => {
    expect(source).toContain("reportModalOpen");
    expect(source).toContain("closeReportModal");
  });
});

describe("report types", () => {
  it("defines 10 report types", () => {
    expect(source).toContain("light-rain");
    expect(source).toContain("heavy-rain");
    expect(source).toContain("thunderstorm");
    expect(source).toContain("hail");
    expect(source).toContain("flooding");
    expect(source).toContain("strong-wind");
    expect(source).toContain("clear-skies");
    expect(source).toContain("fog");
    expect(source).toContain("dust");
    expect(source).toContain("frost");
  });

  it("defines 3 severity levels", () => {
    expect(source).toContain('"mild"');
    expect(source).toContain('"moderate"');
    expect(source).toContain('"severe"');
  });
});

describe("3-step wizard flow", () => {
  it("has select, clarify, and confirm steps", () => {
    expect(source).toContain('"select"');
    expect(source).toContain('"clarify"');
    expect(source).toContain('"confirm"');
  });

  it("calls AI clarification endpoint", () => {
    expect(source).toContain("/api/py/reports/clarify");
  });

  it("submits report to POST /api/py/reports", () => {
    expect(source).toContain('fetch("/api/py/reports"');
  });

  it("includes reportType and severity in submission", () => {
    expect(source).toContain("reportType");
    expect(source).toContain("severity");
    expect(source).toContain("description");
  });
});

describe("accessibility", () => {
  it("has 44px minimum touch targets", () => {
    expect(source).toContain("min-h-[48px]");
  });

  it("uses role=radiogroup for severity selection", () => {
    expect(source).toContain('role="radiogroup"');
    expect(source).toContain('role="radio"');
    expect(source).toContain("aria-checked");
  });

  it("uses role=group for type selector", () => {
    expect(source).toContain('role="group"');
    expect(source).toContain('aria-label="Weather condition type"');
  });

  it("uses global styles only — no hardcoded colors", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}[^)]/);
    expect(source).not.toContain("style={{");
  });
});
