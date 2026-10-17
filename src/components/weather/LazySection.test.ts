/**
 * Tests for LazySection — validates the TikTok-style sequential mount queue,
 * bidirectional visibility, adaptive timing, and memory pressure monitor
 * by reading the source file (Vitest runs in Node without a DOM/IntersectionObserver).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const lazyVisibility = readFileSync(
  resolve(__dirname, "../../lib/lazy-visibility.ts"),
  "utf-8",
);
const source = readFileSync(resolve(__dirname, "LazySection.tsx"), "utf-8");
const skeletonSource = readFileSync(
  resolve(__dirname, "SectionSkeleton.tsx"),
  "utf-8",
);

describe("LazySection — sequential mount queue", () => {
  it("defines one global mountQueue from createMountQueue", () => {
    expect(source).toContain("const mountQueue = createMountQueue(");
  });

  it("bounds concurrent mounts with an activeMounts counter and maxConcurrentMounts", () => {
    // The queue's behaviour is tested in src/lib/mount-queue.test.ts.
    expect(source).toContain("createMountQueue({");
    expect(source).toContain(
      "getSlots: () => maxConcurrentMounts(readDeviceHints())",
    );
  });

  it("exports the LazySection component", () => {
    expect(source).toContain("export function LazySection");
  });

  it("enqueues mounts one at a time via enqueueMount", () => {
    expect(source).toContain("enqueueMount");
    expect(source).toContain("mountQueue.enqueue(mountFn)");
  });

  it("uses requestAnimationFrame + setTimeout for paint-safe mounting", () => {
    expect(source).toContain("requestAnimationFrame");
    expect(source).toContain("setTimeout");
  });

  it("cancels pending queue entries on cleanup", () => {
    expect(source).toContain("cancelRef.current?.()");
    expect(
      readFileSync(resolve(__dirname, "../../lib/mount-queue.ts"), "utf-8"),
    ).toContain("entry.cancelled = true");
  });
});

describe("LazySection — adaptive settle delay", () => {
  it("takes its settle delay from settleDelayMs (unit tested in lazy-visibility)", () => {
    expect(source).toContain("settleDelayMs(readDeviceHints())");
    expect(source).toContain("readDeviceHints()");
  });

  it("handles SSR by returning a safe default when window is undefined", () => {
    // readDeviceHints guards against typeof window === "undefined"
    expect(lazyVisibility).toContain('typeof window === "undefined"');
  });
});

describe("LazySection — bidirectional visibility", () => {
  it("derives the unload margin from the load margin (never under 1500px)", () => {
    expect(source).toContain("unloadMarginPx(");
    expect(lazyVisibility).toContain("MIN_UNLOAD_MARGIN_PX = 1500");
  });

  it("uses a separate unload observer after initial mount", () => {
    // Should have two IntersectionObserver usages: load and unload
    const observerCount = (source.match(/new IntersectionObserver/g) || [])
      .length;
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

  it("takes the load margin from loadMarginPx (viewport-relative)", () => {
    expect(source).toContain("loadMarginPx(readDeviceHints())");
  });
});

describe("LazySection — default fallback is the shared SectionSkeleton", () => {
  it("imports SectionSkeleton instead of hand-rolling a placeholder", () => {
    expect(source).toContain(
      'import { SectionSkeleton } from "@/components/weather/SectionSkeleton"',
    );
    expect(source).toContain('<SectionSkeleton className="h-48" />');
    expect(source).not.toContain("animate-pulse");
  });

  it("SectionSkeleton carries role=status and an aria-label for loading state", () => {
    expect(skeletonSource).toContain('role="status"');
    expect(skeletonSource).toContain('aria-label="Loading section"');
  });

  it("SectionSkeleton uses the chameleon skeleton surface (pulses via globals.css)", () => {
    expect(skeletonSource).toContain("chameleon");
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

describe("LazySection — flicker guards (mount/unmount loop regression)", () => {
  it("decides unloads through shouldUnloadSection with a layout-box check", () => {
    expect(source).toContain("shouldUnloadSection");
    expect(source).toContain("hasLayoutBox: hasLayoutBox(el)");
  });

  it("no longer unmounts on a bare !entry.isIntersecting", () => {
    expect(source).not.toMatch(
      /if \(!entry\.isIntersecting\) \{\s*setVisible\(false\)/,
    );
  });

  it("reserves the content's measured height while unmounted", () => {
    expect(source).toContain(
      "reservedHeightPx(entry.boundingClientRect.height)",
    );
    expect(source).toContain('"--lazy-reserved-height"');
    expect(source).toContain("min-h-[var(--lazy-reserved-height)]");
  });

  it("releases the reserved height when the section remounts", () => {
    const mountBlock = source.slice(
      source.indexOf("enqueueMount(() => {"),
      source.indexOf("hasRendered.current = true;"),
    );
    expect(mountBlock).toContain("setReserved(false)");
  });
});
