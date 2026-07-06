/**
 * Tests for Header — validates the mobile bottom navigation is a floating
 * glass pill (detached, rounded, stays visible on scroll) while preserving
 * its nav items, accessibility, and touch-target sizing. Shamwari is a 5th
 * item gated behind the shamwari_chat feature flag (paused by default).
 * Reads source file directly (no DOM renderer needed for structural checks).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "Header.tsx"), "utf-8");

describe("Header — mobile nav floating pill", () => {
  it("is a centered, detached floating pill (not an edge-pinned full-width bar)", () => {
    // Floats above the safe-area, horizontally centered
    expect(source).toContain(
      "bottom-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]",
    );
    expect(source).toContain("left-1/2");
    expect(source).toContain("-translate-x-1/2");
    // No longer full-width, edge-pinned
    expect(source).not.toContain("bottom-0 left-0 right-0");
  });

  it("uses pill styling: rounded-full, glass, subtle border, shadow", () => {
    expect(source).toContain("rounded-full");
    expect(source).toContain("bg-surface-base/90");
    expect(source).toContain("backdrop-blur-xl");
    expect(source).toContain("border border-text-tertiary/10");
    expect(source).toContain("shadow-lg");
  });

  it("drops the top border used by the old edge bar", () => {
    expect(source).not.toContain("border-t border-text-tertiary/10");
  });

  it("stays fixed (visible on scroll) and above content via z-40", () => {
    expect(source).toContain("fixed");
    expect(source).toContain("z-40");
  });

  it("inner container is a compact horizontal row, not a full-height bar", () => {
    expect(source).toContain("flex items-center gap-1 px-2 py-1.5");
    expect(source).not.toContain("min-h-[5rem]");
  });

  it("keeps it visible only on mobile (sm:hidden)", () => {
    expect(source).toContain("sm:hidden");
  });
});

describe("Header — mobile nav preserved behaviour", () => {
  it("keeps the 5 always-on nav items and their labels", () => {
    for (const label of ["Weather", "Explore", "My Location", "History", "My Weather"]) {
      expect(source).toContain(`>${label}</span>`);
    }
  });

  it("gates the Shamwari nav item behind the shamwari_chat feature flag (paused by default)", () => {
    expect(source).toContain("shamwariEnabled");
    expect(source).toContain('isFeatureEnabled("shamwari_chat")');
    expect(source).toContain("{shamwariEnabled &&");
    // Still present in source (so re-enabling the flag brings it back), just gated.
    expect(source).toContain(">Shamwari</span>");
  });

  it("preserves the active indicator dot and active text colour", () => {
    expect(source).toContain("rounded-full bg-primary");
    expect(source).toContain("text-primary");
  });

  it("preserves press feedback and aria-current on active items", () => {
    expect(source).toContain("active:scale-95");
    expect(source).toContain('aria-current');
  });

  it("preserves accessible touch targets via the design token", () => {
    expect(source).toContain("min-w-[var(--touch-target-min)]");
    expect(source).toContain("min-h-[var(--touch-target-min)]");
  });

  it("keeps the Mobile navigation aria-label landmark", () => {
    expect(source).toContain('aria-label="Mobile navigation"');
  });
});

describe("Header — My Location centre action", () => {
  it("renders a My Location button with the navigation arrow icon", () => {
    expect(source).toContain(">My Location</span>");
    expect(source).toContain('aria-label="Use my current location"');
    expect(source).toContain("<NavigationIcon size={22} />");
  });

  it("uses the shared geolocation flow with auto-create (same as My Weather modal)", () => {
    // Deferred import keeps geolocation out of the initial header bundle
    expect(source).toContain('await import("@/lib/geolocation")');
    expect(source).toContain("detectUserLocation({ autoCreate: true })");
  });

  it("navigates to the detected location and syncs the store", () => {
    expect(source).toContain("setSelectedLocation(result.location.slug)");
    expect(source).toContain("router.push(`/${result.location.slug}`)");
  });

  it("falls back to the My Weather modal on denial or failure", () => {
    // The modal's Location tab has search + a geolocation retry with error
    // copy — the user is never stranded on a silent failure.
    expect(source).toMatch(/} else \{\s*openMyWeather\(\);/);
  });

  it("shows a spinner and guards against double-taps while locating", () => {
    expect(source).toContain("if (locating) return;");
    expect(source).toContain("aria-busy={locating}");
    expect(source).toContain("disabled={locating}");
    expect(source).toContain("<Spinner");
  });

  it("tracks geolocation_result and location_changed analytics events", () => {
    expect(source).toContain('trackEvent("geolocation_result"');
    expect(source).toContain('trackEvent("location_changed"');
    expect(source).toContain('method: "geolocation"');
  });
});

describe("Header — notifications popover accessibility (issue #95)", () => {
  it("announces as a dialog, not a menu (it has no menuitems)", () => {
    expect(source).toContain('role="dialog"');
    expect(source).not.toContain('role="menu"');
    expect(source).toContain('aria-haspopup="dialog"');
  });

  it("closes on Escape and returns focus to the bell button", () => {
    expect(source).toContain('e.key === "Escape"');
    expect(source).toContain("bellButtonRef.current?.focus()");
    expect(source).toContain("ref={bellButtonRef}");
  });

  it("cleans up both the outside-click and keydown listeners", () => {
    expect(source).toContain('document.removeEventListener("mousedown", handleClick)');
    expect(source).toContain('document.removeEventListener("keydown", handleKeydown)');
  });
});

describe("Header — wordmark alignment", () => {
  it("keeps the brand mark left-aligned at every breakpoint (no mx-auto centering)", () => {
    // The mobile-centered "Netflix-style" treatment regressed the original
    // left-aligned wordmark — the logo link must not center itself.
    expect(source).not.toContain('className="mx-auto sm:mx-0 flex items-center"');
    expect(source).toContain('aria-label="mukoko weather — return to home page"');
  });
});
