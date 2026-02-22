/**
 * Tests for the /shamwari page — validates layout, metadata,
 * loading skeletons, and chatbot integration.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const pageSource = readFileSync(resolve(__dirname, "page.tsx"), "utf-8");
const clientSource = readFileSync(resolve(__dirname, "ShamwariPageClient.tsx"), "utf-8");
const loadingSource = readFileSync(resolve(__dirname, "loading.tsx"), "utf-8");
const errorSource = readFileSync(resolve(__dirname, "error.tsx"), "utf-8");

describe("shamwari page — structure", () => {
  it("exports metadata with Shamwari title", () => {
    expect(pageSource).toContain("Shamwari | mukoko weather");
  });

  it("renders Header", () => {
    expect(pageSource).toContain("Header");
  });

  it("renders ShamwariPageClient", () => {
    expect(pageSource).toContain("ShamwariPageClient");
  });

  it("does not render Footer (full-viewport chat layout)", () => {
    expect(pageSource).not.toContain("Footer");
  });
});

describe("shamwari page client — chatbot integration", () => {
  it("lazy-loads ExploreChatbot", () => {
    expect(clientSource).toContain("lazy(");
    expect(clientSource).toContain("ExploreChatbot");
  });

  it("wraps chatbot in ChartErrorBoundary", () => {
    expect(clientSource).toContain("ChartErrorBoundary");
  });

  it("wraps chatbot in Suspense with ChatSkeleton fallback", () => {
    expect(clientSource).toContain("Suspense");
    expect(clientSource).toContain("ChatSkeleton");
  });

  it("uses full-viewport height layout (100dvh)", () => {
    expect(clientSource).toContain("100dvh");
  });

  it("accounts for mobile bottom nav with pb-[4.5rem]", () => {
    expect(clientSource).toContain("pb-[4.5rem]");
    expect(clientSource).toContain("sm:pb-0");
  });
});

describe("shamwari loading skeleton", () => {
  it("renders Header", () => {
    expect(loadingSource).toContain("Header");
  });

  it("has role=\"status\" with aria-busy", () => {
    expect(loadingSource).toContain('role="status"');
    expect(loadingSource).toContain('aria-busy="true"');
  });

  it("has sr-only text for screen readers", () => {
    expect(loadingSource).toContain("sr-only");
    expect(loadingSource).toContain("Loading");
  });

  it("uses ChatSkeleton component", () => {
    expect(loadingSource).toContain("ChatSkeleton");
  });

  it("accounts for mobile bottom nav spacing", () => {
    expect(loadingSource).toContain("pb-[4.5rem]");
    expect(loadingSource).toContain("sm:pb-0");
  });
});

describe("shamwari error boundary", () => {
  it("is a client component", () => {
    expect(errorSource).toContain('"use client"');
  });

  it("shows Chat Unavailable heading", () => {
    expect(errorSource).toContain("Chat Unavailable");
  });

  it("uses retry count tracking from error-retry", () => {
    expect(errorSource).toContain("getRetryCount");
    expect(errorSource).toContain("setRetryCount");
    expect(errorSource).toContain("MAX_RETRIES");
  });

  it("reports errors to analytics", () => {
    expect(errorSource).toContain("reportErrorToAnalytics");
    expect(errorSource).toContain("shamwari:");
  });

  it("provides issue reporting link", () => {
    expect(errorSource).toContain("buildIssueUrl");
    expect(errorSource).toContain("Report this issue");
  });

  it("provides home navigation link", () => {
    expect(errorSource).toContain('href="/"');
    expect(errorSource).toContain("Go home");
  });
});
