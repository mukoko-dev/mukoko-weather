/**
 * Tests for Header — the mobile navigation island (a floating, centred pill
 * with map / page indicator / list, matching the mukoko-news island) and the
 * mobile "⋯" menu that holds the destinations the island does not show.
 * Desktop header stays as it was. Reads source directly (no DOM renderer
 * needed for structural checks).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "Header.tsx"), "utf-8");
const nav = readFileSync(resolve(__dirname, "MobileNav.tsx"), "utf-8");
const css = readFileSync(resolve(__dirname, "../../app/globals.css"), "utf-8");
/** The body of one `@layer components` rule in globals.css. */
function rule(name: string): string {
  const m = css.match(new RegExp(`\\.${name} \\{([^}]*)\\}`));
  return m ? m[1] : "";
}

describe("Header — mounts the floating mobile navigation", () => {
  it("renders MobileNav with the saved locations, pathname and map link", () => {
    expect(source).toContain(
      'import { MobileNav } from "@/components/layout/MobileNav"',
    );
    expect(source).toContain("<MobileNav");
    expect(source).toContain("savedLocations={savedLocations}");
    expect(source).toContain("pathname={pathname}");
    expect(source).toContain("mapHref={mapHref}");
    expect(source).toContain(
      "const savedLocations = useAppStore((s) => s.savedLocations);",
    );
  });

  it("no longer welds a full-width bar to the bottom edge", () => {
    expect(source).not.toContain("fixed inset-x-0 bottom-0");
    expect(nav).not.toContain("inset-x-0 bottom-0");
    expect(nav).not.toContain("border-t");
  });
});

describe("MobileNav — floating island geometry (.lourie)", () => {
  it("is a centred, capped-width pill inset from both sides", () => {
    const lourie = rule("lourie");
    expect(nav).toContain('className="lourie sm:hidden"');
    expect(lourie).toContain("fixed inset-x-4");
    expect(lourie).toContain("mx-auto");
    expect(lourie).toContain("max-w-md");
    expect(lourie).toContain("rounded-full");
    expect(lourie).toContain("shadow-lg");
    expect(lourie).toContain("backdrop-blur-xl");
  });

  it("is lifted off the bottom by the safe-area inset plus the nav inset token", () => {
    expect(rule("lourie")).toContain(
      "bottom: calc(env(safe-area-inset-bottom, 0px) + var(--mobile-nav-inset))",
    );
  });

  it("takes its height from the token the content clearance is computed from", () => {
    expect(rule("lourie")).toContain("h-[var(--mobile-nav-height)]");
    expect(css).toMatch(
      /--mobile-nav-clearance: calc\(\s*env\(safe-area-inset-bottom, 0px\) \+ var\(--mobile-nav-inset\) \+\s*var\(--mobile-nav-height\)/,
    );
  });

  it("is phone-only and keeps its landmark label", () => {
    expect(nav).toContain('aria-label="Mobile navigation"');
    expect(nav).toContain("sm:hidden");
  });

  it("end slots are .duiker round controls on the 48px touch-target token", () => {
    const duiker = rule("duiker");
    expect(duiker).toContain("w-[var(--touch-target-min)]");
    expect(duiker).toContain("h-[var(--touch-target-min)]");
    expect(duiker).toContain("aria-[current=page]:text-primary");
    expect(duiker).toContain("focus-visible:outline-2");
    expect(nav.match(/className="duiker"/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("MobileNav — parts", () => {
  it("left: a Map link to the map of the location on screen", () => {
    expect(nav).toMatch(
      /import \{[^}]*Map as MapIcon[^}]*\} from "lucide-react"/,
    );
    expect(nav).toContain("<MapIcon size={NAV_ICON_SIZE}");
    expect(nav).toContain("href={mapHref}");
    expect(nav).toContain('? "Weather map"');
  });

  it("centre: the LocationPager inside a harness boundary with a working fallback", () => {
    expect(nav).toContain(
      'import { LocationPager } from "@/components/layout/LocationPager"',
    );
    expect(nav).toContain("<LocationPager");
    expect(nav).toMatch(/<MziziHarness\s+name="location-pager"/);
    expect(nav).toContain("href={MY_LOCATION_HREF}");
  });

  it("right: a List link to /locations with aria-current when active", () => {
    expect(nav).toMatch(
      /import \{[^}]*List as ListIcon[^}]*\} from "lucide-react"/,
    );
    expect(nav).toContain("<ListIcon size={NAV_ICON_SIZE}");
    expect(nav).toContain('href="/locations"');
    expect(nav).toContain('aria-label="All locations"');
    expect(nav).toContain('aria-current={isLocationList ? "page" : undefined}');
  });

  it("uses one icon size for both ends", () => {
    expect(nav).toContain("export const NAV_ICON_SIZE = 22;");
  });

  it("no longer renders the old five-item nav row", () => {
    expect(source).not.toContain('aria-label="Weather home"');
    expect(source).not.toContain('aria-label="Explore locations"');
    expect(source).not.toContain('aria-label="Weather history"');
    expect(source).not.toContain('aria-label="My Weather settings"');
  });
});

describe("Header — mobile ⋯ menu holds the moved destinations", () => {
  it("has a labelled disclosure button that controls the menu", () => {
    expect(source).toContain('aria-label="More options"');
    expect(source).toContain('aria-controls="mobile-more-menu"');
    expect(source).toContain("aria-expanded={menuOpen}");
    expect(source).toContain('id="mobile-more-menu"');
    expect(source).toContain("import { Ellipsis");
  });

  it("is mobile-only, sitting inside the existing icon pill", () => {
    expect(source).toContain(
      '<div className="relative sm:hidden" ref={menuRef}>',
    );
  });

  it("contains Explore, History, Aviation, My Weather and Use my location", () => {
    expect(source).toMatch(/href="\/explore"[\s\S]*?\n\s*Explore\s*<\/Link>/);
    expect(source).toMatch(/href="\/history"[\s\S]*?\n\s*History\s*<\/Link>/);
    expect(source).toMatch(/href="\/aviation"[\s\S]*?\n\s*Aviation\s*<\/Link>/);
    expect(source).toMatch(
      /openMyWeather\(\);[\s\S]*?\n\s*My Weather\s*<\/button>/,
    );
    expect(source).toMatch(/void handleMyLocation\(\);[\s\S]*?Use my location/);
  });

  it("keeps Shamwari in the menu behind the shamwari_chat flag", () => {
    expect(source).toContain("{shamwariEnabled && (");
    expect(source).toContain('href="/shamwari"');
  });

  it("closes on item activation, outside click and Escape (returning focus)", () => {
    expect(source).toContain("onClick={() => setMenuOpen(false)}");
    expect(source).toContain(
      "setMenuOpen(false);\n                            openMyWeather();",
    );
    expect(source).toContain('e.key === "Escape"');
    expect(source).toContain("menuButtonRef.current?.focus()");
    expect(source).toContain(
      'document.removeEventListener("mousedown", handleClick)',
    );
  });

  it("the Use my location item keeps the busy state and double-tap guard", () => {
    expect(source).toContain("disabled={locating}");
    expect(source).toContain("aria-busy={locating}");
    expect(source).toContain("if (locating) return;");
  });
});

describe("Header — header pill on phones", () => {
  it("hides the duplicate map button on phones (the bottom bar has it)", () => {
    expect(source).toContain('className="bee hidden sm:flex"');
  });

  it("keeps the desktop text nav unchanged", () => {
    expect(source).toContain('aria-label="Main navigation"');
    expect(source).toContain('className="hidden sm:flex items-center gap-6"');
  });
});

describe("Header — My Location (GPS) action", () => {
  it("uses the shared geolocation flow with auto-create (same as My Weather modal)", () => {
    expect(source).toContain('await import("@/lib/geolocation")');
    expect(source).toContain("detectUserLocation({ autoCreate: true })");
  });

  it("selects the detected location and returns to the home page (no slug URL)", () => {
    expect(source).toContain("setSelectedLocation(result.location.slug)");
    expect(source).toContain('router.push("/")');
    expect(source).not.toContain("router.push(`/${result.location.slug}`)");
  });

  it("only accepts a valid location slug from geolocation", () => {
    expect(source).toContain("isLocationSlug(result.location.slug)");
  });

  it("falls back to the My Weather modal on denial or failure", () => {
    expect(source).toMatch(/} else \{\s*openMyWeather\(\);/);
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
    expect(source).toContain(
      'document.removeEventListener("mousedown", handleClick)',
    );
    expect(source).toContain(
      'document.removeEventListener("keydown", handleKeydown)',
    );
  });
});

describe("Header — wordmark alignment", () => {
  it("keeps the brand mark left-aligned at every breakpoint (no mx-auto centering)", () => {
    // The mobile-centered "Netflix-style" treatment regressed the original
    // left-aligned wordmark — the logo link must not center itself.
    expect(source).not.toContain(
      'className="mx-auto sm:mx-0 flex items-center"',
    );
    expect(source).toContain(
      'aria-label="mukoko weather — return to home page"',
    );
  });
});

describe("Header — weather map link", () => {
  it("never defaults to a hardcoded city", () => {
    expect(source).not.toContain("harare");
    expect(source).not.toContain('|| "');
  });

  it("derives the slug from the current location (first path segment or store)", () => {
    expect(source).toMatch(
      /import \{[^}]*currentLocationSlug[^}]*isLocationSlug[^}]*\} from "@\/lib\/current-slug"/,
    );
    expect(source).toContain(
      "const mapSlug = currentLocationSlug(pathname, selectedLocation);",
    );
  });

  it("links to /{slug}/map when a location is known, otherwise to /explore", () => {
    expect(source).toContain(
      'const mapHref = mapSlug ? `/${mapSlug}/map` : "/explore";',
    );
    expect(source).toContain("href={mapHref}");
    expect(source).toContain("Choose a location for the weather map");
  });
});

describe("Header — My Location button", () => {
  it("seeds the home page with the found place and refreshes it in place on /", () => {
    expect(source).toContain("writeLastLocationCookie(result.location.slug)");
    expect(source).toContain("new CustomEvent(CURRENT_LOCATION_EVENT");
    expect(source).toContain('router.push("/")');
  });
});
