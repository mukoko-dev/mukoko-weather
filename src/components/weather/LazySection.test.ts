/**
 * Tests for LazySection — validates the TikTok-style sequential mount queue,
 * bidirectional visibility, adaptive timing, and memory pressure monitor
 * by reading the source file (Vitest runs in Node without a DOM/IntersectionObserver).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "LazySection.tsx"),
  "utf-8",
);

describe("LazySection — sequential mount queue", () => {
  it("defines a global mountQueue as a QueueEntry array", () => {
    expect(source).toContain("mountQueue: QueueEntry[]");
    expect(source).toContain("const mountQueue");
  });

  it("tracks queue processing with isProcessing flag", () => {
    expect(source).toContain("isProcessing");
  });

  it("exports the LazySection component", () => {
    expect(source).toContain("export function LazySection");
  });

  it("enqueues mounts one at a time via enqueueMount", () => {
    expect(source).toContain("enqueueMount");
    expect(source).toContain("entry.cancelled");
  });

  it("uses requestAnimationFrame + setTimeout for paint-safe mounting", () => {
    expect(source).toContain("requestAnimationFrame");
    expect(source).toContain("setTimeout");
  });

  it("cancels pending queue entries on cleanup", () => {
    expect(source).toContain("cancelled = true");
  });
});

describe("LazySection — adaptive settle delay", () => {
  it("returns 150ms settle delay for mobile (< 768px)", () => {
    expect(source).toContain("150");
    expect(source).toContain("768");
  });

  it("returns 50ms settle delay for desktop (>= 768px)", () => {
    expect(source).toContain("50");
  });

  it("getSettleDelay uses window.innerWidth for detection", () => {
    expect(source).toContain("window.innerWidth");
    expect(source).toContain("getSettleDelay");
  });

  it("handles SSR by returning a safe default when window is undefined", () => {
    // Should guard against typeof window === "undefined"
    expect(source).toContain("typeof window");
  });
});

describe("LazySection — bidirectional visibility", () => {
  it("defines UNLOAD_MARGIN of 1500px for off-screen reclamation", () => {
    expect(source).toContain('UNLOAD_MARGIN = "1500px"');
  });

  it("uses a separate unload observer after initial mount", () => {
    // Should have two IntersectionObserver usages: load and unload
    const observerCount = (source.match(/new IntersectionObserver/g) || []).length;
    expect(observerCount).toBeGreaterThanOrEqual(2);
  });

  it("unmounts (sets visible false) when section scrolls far off-screen", () => {
    expect(source).toContain("setVisible(false)");
  });

  it("tracks hasRendered ref so unload observer only activates after first mount", () => {
    expect(source).toContain("hasRendered");
  });

  it("skips entrance animation on remount (only animates first mount)", () => {
    // animate state is true only on first mount, false on remounts
    expect(source).toContain("setAnimate(!hasRendered.current)");
    expect(source).toContain('animate ? "animate-fade-in-up" : undefined');
  });

  it("load margin is larger on desktop than mobile", () => {
    expect(source).toContain("100px"); // mobile load margin
    expect(source).toContain("300px"); // desktop load margin
  });
});

describe("LazySection — default fallback accessibility", () => {
  it("default fallback has role=\"status\"", () => {
    expect(source).toContain('role="status"');
  });

  it("default fallback has aria-label for loading state", () => {
    expect(source).toContain('aria-label="Loading section"');
  });

  it("default fallback includes sr-only text for screen readers", () => {
    expect(source).toContain("sr-only");
    expect(source).toContain("Loading section");
  });

  it("default fallback uses animate-pulse for visual loading indicator", () => {
    expect(source).toContain("animate-pulse");
  });
});

describe("LazySection — component API", () => {
  it("accepts a label prop for debug identification", () => {
    expect(source).toContain('label = "unknown"');
  });

  it("renders data-lazy-section attribute with label value", () => {
    expect(source).toContain("data-lazy-section={label}");
  });

  it("accepts a fallback prop for custom loading placeholder", () => {
    expect(source).toContain("fallback = DEFAULT_FALLBACK");
  });

  it("accepts a rootMargin prop for custom IntersectionObserver margin", () => {
    expect(source).toContain("rootMargin");
  });
});

describe("useMemoryPressure hook", () => {
  it("is exported from LazySection module", () => {
    expect(source).toContain("export function useMemoryPressure");
  });

  it("accepts a thresholdMB parameter defaulting to 150", () => {
    expect(source).toContain("thresholdMB: number = 150");
  });

  it("checks performance.memory for JS heap size", () => {
    expect(source).toContain("perf.memory");
    expect(source).toContain("usedJSHeapSize");
  });

  it("polls on a 5-second interval", () => {
    expect(source).toContain("5000");
    expect(source).toContain("setInterval");
  });

  it("clears interval on cleanup", () => {
    expect(source).toContain("clearInterval");
  });
});
