/**
 * Tests for LocationPager — the bottom bar's page indicator and the swipe hook
 * that walks the same sequence. Source-level checks (no DOM renderer), with the
 * pure sequence logic covered in src/lib/location-pager.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "LocationPager.tsx"), "utf-8");

describe("LocationPager — accessible page indicator", () => {
  it("is a labelled group inside the bottom bar's navigation, not a nested nav landmark", () => {
    expect(source).toContain('role="group"');
    expect(source).toContain('aria-label="Location pages"');
    expect(source).not.toMatch(/<nav[\s>]/);
    expect(source).not.toMatch(/<\/nav>/);
  });

  it("labels the home glyph My Location and points it at /", () => {
    expect(source).toContain('aria-label="My Location"');
    expect(source).toContain("href={MY_LOCATION_HREF}");
  });

  it("labels each saved-location dot with its place name", () => {
    expect(source).toContain("displayNameFromSlug(slug)");
    expect(source).toContain("aria-label={name}");
  });

  it("marks the current page with aria-current='page' and no other item", () => {
    expect(source).toContain(
      'aria-current={activeIndex === 0 ? "page" : undefined}',
    );
    expect(source).toContain('aria-current={isActive ? "page" : undefined}');
  });

  it("highlights the current dot: primary and elongated, others small and muted", () => {
    expect(source).toContain(
      'isActive ? "w-5 bg-primary" : "w-2 bg-text-tertiary/50"',
    );
  });

  it("draws no surface of its own: the dots sit on the nav island", () => {
    expect(source).not.toContain("bg-surface-card/80");
    expect(source).not.toContain("border border-text-tertiary/10");
    expect(source).toContain("mx-auto flex w-max items-center");
  });

  it("shows a visible focus ring on every page item", () => {
    expect(source).toContain("focus-visible:outline-primary");
  });

  it("keeps every item at the 48px touch-target token", () => {
    expect(source).toContain(
      "h-[var(--touch-target-min)] min-w-[var(--touch-target-min)]",
    );
  });

  it("caps the dots through pagerDots (MAX_PAGER_DOTS)", () => {
    expect(source).toContain("pagerDots(sequence)");
  });

  it("scrolls the pill to keep the current item centred, honouring reduced motion", () => {
    expect(source).toContain("scroller.scrollTo({");
    expect(source).toContain("behavior: getScrollBehavior()");
    expect(source).toContain("scrollbar-hide");
  });

  it("navigates by plain links (no JS router push) and tracks saved-location taps", () => {
    expect(source).toContain("href={href}");
    expect(source).toContain(
      "onClick={() => trackPageChange(href, slug, from)}",
    );
    expect(source).toContain('method: "saved"');
  });

  it("uses only design tokens, no inline styles or hex colours", () => {
    expect(source).not.toMatch(/style=\{\{/);
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});

describe("useLocationSwipe — swipe between locations", () => {
  it("maps a left swipe to the next page and a right swipe to the previous", () => {
    expect(source).toContain("onSwipeLeft: () => step(1)");
    expect(source).toContain("onSwipeRight: () => step(-1)");
  });

  it("navigates with the router and never wraps (neighbour returns null at the ends)", () => {
    expect(source).toContain(
      "neighbour(sequence, pagerIndex(pathname, sequence), dir)",
    );
    expect(source).toContain("if (!target) return;");
    expect(source).toContain("router.push(target);");
  });

  it("takes its sequence from the shared usePagerSequence hook, the same as the dots", () => {
    expect(source).toContain(
      "const savedLocations = useAppStore((s) => s.savedLocations);",
    );
    expect(source).toContain(
      "const sequence = usePagerSequence(savedLocations, selectedLocation);",
    );
  });

  it("warms both neighbouring pages when idle so a swipe lands quickly", () => {
    expect(source).toContain("router.prefetch(target)");
    expect(source).toContain("requestIdleCallback");
    expect(source).toContain("neighbour(sequence, index, 1)");
    expect(source).toContain("neighbour(sequence, index, -1)");
  });

  it("can be switched off, e.g. while reordering sections", () => {
    expect(source).toContain("enabled = true,");
    expect(source).toContain("}: { enabled?: boolean } = {})");
    expect(source).toContain("return useSwipe({");
  });
});

describe("pager sequence — one source for the dots and the swipe", () => {
  /** The function body that starts at `start` and ends at the next top-level `}`. */
  function bodyFrom(start: string): string {
    const at = source.indexOf(start);
    expect(at).toBeGreaterThan(-1);
    const end = source.indexOf("\n}\n", at);
    return source.slice(at, end + 3);
  }

  it("defines usePagerSequence exactly once and it is the only place pagerSequence is called", () => {
    expect(source.match(/export function usePagerSequence\(/g)).toHaveLength(1);
    expect(source.match(/\bpagerSequence\(/g)).toHaveLength(1);
    expect(bodyFrom("export function usePagerSequence(")).toContain(
      "pagerSequence(",
    );
  });

  it("is called by both LocationPager and useLocationSwipe with the same arguments", () => {
    expect(
      source.match(/usePagerSequence\(savedLocations, selectedLocation\)/g),
    ).toHaveLength(2);
    expect(bodyFrom("export function LocationPager(")).toContain(
      "usePagerSequence(savedLocations, selectedLocation)",
    );
    expect(bodyFrom("export function useLocationSwipe(")).toContain(
      "usePagerSequence(savedLocations, selectedLocation)",
    );
  });

  it("reads the hidden-preset and anchor state only inside the shared hook", () => {
    expect(source.match(/visiblePresetSlugs\(\{/g)).toHaveLength(1);
    expect(source.match(/s\.hiddenPresetSlugs/g)).toHaveLength(1);
    expect(source.match(/s\.presetAnchor/g)).toHaveLength(1);
  });
});
