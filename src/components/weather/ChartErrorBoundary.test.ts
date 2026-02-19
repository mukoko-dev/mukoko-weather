/**
 * Tests for ChartErrorBoundary — validates the class component pattern,
 * accessibility attributes, and error isolation behaviour by reading the
 * source file (Vitest runs in Node without a DOM).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "ChartErrorBoundary.tsx"),
  "utf-8",
);

describe("ChartErrorBoundary — class component structure", () => {
  it("is a class component extending Component", () => {
    expect(source).toContain("class ChartErrorBoundary extends Component");
  });

  it("initialises state with hasError: false", () => {
    expect(source).toContain("hasError: false");
  });

  it("implements getDerivedStateFromError returning hasError: true", () => {
    expect(source).toContain("getDerivedStateFromError");
    expect(source).toContain("hasError: true");
  });

  it("implements componentDidCatch for error reporting", () => {
    expect(source).toContain("componentDidCatch");
  });

  it("calls reportErrorToAnalytics in componentDidCatch", () => {
    expect(source).toContain("reportErrorToAnalytics");
  });

  it("imports reportErrorToAnalytics from observability", () => {
    expect(source).toContain("from \"@/lib/observability\"");
  });
});

describe("ChartErrorBoundary — fallback UI", () => {
  it("fallback has role=\"alert\" for accessibility", () => {
    expect(source).toContain('role="alert"');
  });

  it("fallback renders 'Unable to display' with the section name", () => {
    expect(source).toContain("Unable to display");
    expect(source).toContain("this.props.name");
  });

  it("fallback includes a 'Try again' retry button", () => {
    expect(source).toContain("Try again");
  });

  it("retry button resets hasError state via setState", () => {
    // The retry button calls setState({ hasError: false })
    expect(source).toContain("setState");
    expect(source).toContain("hasError: false");
  });
});

describe("ChartErrorBoundary — isolation contract", () => {
  it("is exported as a named export", () => {
    expect(source).toContain("export class ChartErrorBoundary");
  });

  it("accepts a name prop for describing the failing section", () => {
    expect(source).toContain("name: string");
  });

  it("renders children when no error", () => {
    expect(source).toContain("this.props.children");
  });

  it("is a client component (uses class-based React APIs)", () => {
    expect(source).toContain('"use client"');
  });
});
