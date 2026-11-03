/**
 * Tests for use-location-pager — the page sequence and the swipe hook that
 * walks it. Source-level checks (no DOM renderer), with the pure sequence
 * logic covered in src/lib/location-pager.test.ts and the lane that renders
 * the same sequence in src/components/layout/PlaceLane.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "use-location-pager.ts"),
  "utf-8",
);
const lane = readFileSync(
  resolve(__dirname, "../components/layout/PlaceLane.tsx"),
  "utf-8",
);

describe("useLocationSwipe — swipe between locations", () => {
  it("maps a left swipe to the next page and a right swipe to the previous", () => {
    expect(source).toContain("onSwipeLeft: () => step(1)");
    expect(source).toContain("onSwipeRight: () => step(-1)");
  });

  it("navigates in place and never wraps (neighbour returns null at the ends)", () => {
    expect(source).toContain(
      "neighbour(sequence, pagerIndex(pathname, sequence), dir)",
    );
    expect(source).toContain("if (!target) return;");
    expect(source).toContain(
      "navigateToPlace(target, (href) => router.push(href));",
    );
    // The swipe no longer calls the router directly for a place.
    expect(source).not.toContain("router.push(target);");
  });

  it("tracks a swipe to a saved place the same way a chip tap is tracked", () => {
    expect(source).toContain("trackPlaceChange(");
    expect(source).toContain('method: "saved"');
    // Home is not a saved slug, so a move to My Location sends nothing.
    expect(source).toContain("if (href === MY_LOCATION_HREF) return;");
  });

  it("takes its sequence from the shared usePagerSequence hook, the same as the lane", () => {
    expect(source).toContain(
      "const savedLocations = useAppStore((s) => s.savedLocations);",
    );
    expect(source).toContain(
      "const sequence = usePagerSequence(savedLocations, selectedLocation);",
    );
  });

  it("does not prefetch neighbouring routes: a swipe is a state change, not a navigation", () => {
    // It used to warm both neighbours' RSC payloads when idle; switching in
    // place needs no route, and a prefetch is a request per neighbour per page.
    expect(source).not.toContain("router.prefetch");
    expect(source).not.toContain("requestIdleCallback");
  });

  it("can be switched off, e.g. while reordering sections", () => {
    expect(source).toContain("enabled = true,");
    expect(source).toContain("}: { enabled?: boolean } = {})");
    expect(source).toContain("return useSwipe({");
  });
});

describe("pager sequence — one source for the lane and the swipe", () => {
  /** The function body that starts at `start` and ends at the next top-level `}`. */
  function bodyFrom(src: string, start: string): string {
    const at = src.indexOf(start);
    expect(at).toBeGreaterThan(-1);
    const end = src.indexOf("\n}\n", at);
    return src.slice(at, end + 3);
  }

  it("defines usePagerSequence exactly once and it is the only place pagerSequence is called", () => {
    expect(source.match(/export function usePagerSequence\(/g)).toHaveLength(1);
    expect(source.match(/\bpagerSequence\(/g)).toHaveLength(1);
    expect(bodyFrom(source, "export function usePagerSequence(")).toContain(
      "pagerSequence(",
    );
    // The lane takes the sequence from the hook and never builds one itself.
    expect(lane).not.toMatch(/\bpagerSequence\(/);
  });

  it("is called by both the lane and useLocationSwipe with the same arguments", () => {
    expect(bodyFrom(lane, "export function PlaceLane(")).toContain(
      "usePagerSequence(savedLocations, selectedLocation)",
    );
    expect(bodyFrom(source, "export function useLocationSwipe(")).toContain(
      "usePagerSequence(savedLocations, selectedLocation)",
    );
  });

  it("reads the hidden-preset and anchor state only inside the shared hook", () => {
    expect(source.match(/visiblePresetSlugs\(\{/g)).toHaveLength(1);
    expect(source.match(/s\.hiddenPresetSlugs/g)).toHaveLength(1);
    expect(source.match(/s\.presetAnchor/g)).toHaveLength(1);
    expect(lane).not.toContain("hiddenPresetSlugs");
  });
});
