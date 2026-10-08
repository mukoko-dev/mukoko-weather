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
  it("is a labelled navigation landmark", () => {
    expect(source).toContain('aria-label="Location pages"');
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

  it("highlights the current dot with the primary colour, others muted", () => {
    expect(source).toContain('isActive ? "bg-primary" : "bg-text-tertiary/50"');
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

  it("derives the sequence from the saved locations, the same as the dots", () => {
    expect(source).toContain(
      "const savedLocations = useAppStore((s) => s.savedLocations);",
    );
    expect(source).toContain("pagerSequence(savedLocations)");
  });

  it("can be switched off, e.g. while reordering sections", () => {
    expect(source).toContain("enabled = true,");
    expect(source).toContain("}: { enabled?: boolean } = {})");
    expect(source).toContain("return useSwipe({");
  });
});
