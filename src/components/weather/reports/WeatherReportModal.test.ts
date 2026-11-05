import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { getReportTypeInfo } from "@/lib/report-types";

const source = readFileSync(
  resolve(__dirname, "WeatherReportModal.tsx"),
  "utf-8",
);

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

  it("uses shadcn Dialog; the shared content brings the top bar and Close", () => {
    expect(source).toContain("<Dialog");
    expect(source).toContain("DialogContent");
    expect(source).toContain("heading={");
    expect(source).not.toContain("DialogSheetHandle");
  });

  it("reads reportModalOpen from store", () => {
    expect(source).toContain("reportModalOpen");
    expect(source).toContain("closeReportModal");
  });
});

describe("report types", () => {
  it("sources report types from the shared report-types module", () => {
    // Single source of truth shared with RecentReports — see
    // src/lib/report-types.ts — instead of a locally hand-synced list. The
    // 13-type coverage and SVG-icon assertions live in report-types.test.ts.
    expect(source).toContain('from "@/lib/report-types"');
    expect(source).toContain("REPORT_TYPES");
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

  it("asks the Worker for the follow-up questions, never /api/py", () => {
    // One helper asks, for the type picked in the wizard and for a type the
    // wizard was opened on (an alert's "Report flooding").
    expect(source).toContain('postWorker(\n      "reports/clarify"');
    expect(source).toContain("CLARIFY_TIMEOUT_MS");
    expect(source).toContain("clarifyQuestions(await res.json())");
    expect(source).not.toContain("/api/py");
    expect(source.match(/"reports\/clarify"/g)).toHaveLength(1);
  });

  it("carries on without questions when the request fails", () => {
    // Clarification is optional: a refusal or a network error gives no
    // questions, and the wizard still moves to the next step.
    expect(source).toMatch(/catch \{\s*return \[\];/);
    expect(source).toMatch(
      /setQuestions\(await fetchQuestions\(locationSlug, typeId\)\);\s*setLoading\(false\);\s*setStep\("clarify"\)/,
    );
  });

  it("can open on a report type and a place chosen by an alert", () => {
    // Read once, at mount, from the store; an unknown type is ignored.
    expect(source).toContain("useAppStore.getState().reportPreset");
    expect(source).toContain("getReportTypeInfo(preset.reportType)");
    expect(source).toContain(
      'useState<Step>(opened.type ? "clarify" : "select")',
    );
    expect(source).toContain(
      "const locationSlug = opened.slug ?? selectedLocation;",
    );
    // The report, the clarify call and the kept list all use the alert's place.
    expect(source).toContain("locationSlug,\n          reportType,");
    expect(source).toContain("forgetReports(locationSlug)");
    expect(source).not.toMatch(/forgetReports\(selectedLocation\)/);
  });

  it("submits the report to the Worker's POST /v1/reports and reads its refusal", () => {
    expect(source).toContain("fetch(reportsSubmitUrl()");
    expect(source).toContain("reportRefusal(body,");
    expect(source).not.toContain('fetch("/api/py/reports"');
  });

  it("includes reportType and severity in submission", () => {
    expect(source).toContain("reportType");
    expect(source).toContain("severity");
    expect(source).toContain("description");
  });
});

describe("a report where someone could be in danger (wildfire)", () => {
  it("says it is not an emergency service in the step that holds Submit", () => {
    // Rendered from the type's own notice (report-types.ts), as a note, above
    // the questions and the Submit button; read by assistive technology but
    // not announced as an alert.
    const clarify = source.slice(
      source.indexOf('{step === "clarify" && ('),
      source.indexOf("Submit Report"),
    );
    expect(clarify).toContain("typeInfo?.notice");
    expect(clarify).toContain('role="note"');
    expect(clarify.indexOf("typeInfo?.notice")).toBeLessThan(
      clarify.indexOf("Help us understand"),
    );
    // The words live once, in report-types.ts, with no phone number.
    expect(source).not.toContain("emergency services");
    expect(source).not.toMatch(/tel:|\d{3}[ -]\d{3}/);
  });

  it("renders the notice as a calm note, not an assertive alert", () => {
    const notice = getReportTypeInfo("wildfire")?.notice ?? "";
    const html = renderToStaticMarkup(
      createElement(
        Alert,
        { variant: "warning", role: "note" },
        createElement(AlertDescription, null, notice),
      ),
    );
    expect(html).toContain('role="note"');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain("This is not an emergency service.");
    expect(html).toContain(
      "If anyone is in danger, call your local emergency services first.",
    );
  });

  it("repeats the notice and how the report is shown once it is sent", () => {
    const confirm = source.slice(source.indexOf('{step === "confirm"'));
    expect(confirm).toContain("typeInfo.sentNote");
    expect(confirm).toContain("typeInfo.notice");
  });
});

describe("accessibility", () => {
  it("has 56px minimum touch targets", () => {
    expect(source).toContain("min-h-[var(--touch-target-min)]");
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
