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

const pager = readFileSync(resolve(__dirname, "LocationPager.tsx"), "utf-8");
const bottomNav = readFileSync(
  resolve(__dirname, "../ui/mzizi-bottom-nav.tsx"),
  "utf-8",
);

describe("Header — mounts the mobile navigation", () => {
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

  it("is a sibling of <header>, never inside it (a backdrop-filter header would capture a fixed child)", () => {
    const headerClose = source.indexOf("</header>");
    expect(headerClose).toBeGreaterThan(0);
    expect(source.indexOf("<MobileNav")).toBeGreaterThan(headerClose);
  });
});

describe("MobileNav — the Mzizi registry bottom nav", () => {
  it("uses the vendored registry MziziBottomNav, not a hand-rolled island", () => {
    expect(nav).toContain('from "@/components/ui/mzizi-bottom-nav"');
    expect(nav).toContain("<MziziBottomNav");
    expect(nav).not.toContain("lourie");
    expect(css).not.toContain(".lourie {");
    expect(bottomNav).toContain('data-slot="mzizi-bottom-nav"');
    expect(bottomNav).toContain(
      'data-portal="https://mzizi.dev/components/mzizi-bottom-nav"',
    );
  });

  it("floats like mukoko-news's island: inset from the edges, lifted, max-w-md, pill, token border, shadow, blur", () => {
    expect(bottomNav).toContain("fixed inset-x-4");
    expect(bottomNav).toContain(
      "bottom-[calc(env(safe-area-inset-bottom,0px)+var(--mobile-nav-inset))]",
    );
    expect(bottomNav).toContain("z-50 mx-auto");
    expect(bottomNav).toContain("max-w-md");
    // Never docked: no full-width edge-to-edge bar, no top-border-only bar.
    const code = bottomNav.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain("inset-x-0 bottom-0");
    expect(code).not.toMatch(/\bborder-t\b/);
    expect(bottomNav).toContain("rounded-full");
    expect(bottomNav).toContain("border-[length:var(--border-width-rest)]");
    expect(bottomNav).toContain("shadow-lg");
    expect(bottomNav).toContain("backdrop-blur-xl");
  });

  it("is 4rem tall; --mobile-nav-height is bar + gap + the pager pill; clearance adds the lift and safe area", () => {
    expect(bottomNav).toContain("h-[var(--mobile-nav-bar-height)]");
    expect(bottomNav).toContain("h-[var(--touch-target-min)] max-w-full");
    expect(css).toContain("--mobile-nav-bar-height: 4rem;");
    expect(css).toContain("--mobile-nav-inset: 0.75rem;");
    expect(css).toMatch(
      /--mobile-nav-height: calc\(\s*var\(--mobile-nav-bar-height\) \+ var\(--mobile-nav-gap\) \+\s*var\(--touch-target-min\)\s*\);/,
    );
    expect(css).toMatch(
      /--mobile-nav-clearance: calc\(\s*env\(safe-area-inset-bottom, 0px\) \+ var\(--mobile-nav-inset\) \+\s*var\(--mobile-nav-height\)/,
    );
  });

  it("the nav wrapper lets taps through; only the pills catch them", () => {
    expect(bottomNav).toContain("pointer-events-none fixed");
    expect(bottomNav).toContain("pointer-events-auto rounded-full");
  });

  it("items are next/link with aria-current and the 48px touch-target floor", () => {
    expect(bottomNav).toContain('import Link from "next/link"');
    expect(bottomNav).not.toMatch(/<a\s/);
    expect(bottomNav).toContain('aria-current={active ? "page" : undefined}');
    expect(bottomNav).toContain("min-h-[var(--touch-target-min)]");
  });

  it("uses tokens, not the upstream hex/rgba fallbacks", () => {
    expect(bottomNav).not.toMatch(/#[0-9A-Fa-f]{3,6}\b/);
    expect(bottomNav).not.toContain("rgba(");
  });

  it("is phone-only and keeps its landmark label", () => {
    expect(nav).toContain('label="Mobile navigation"');
    expect(nav).toContain('className="sm:hidden"');
    expect(bottomNav).toContain("aria-label={label}");
  });
});

describe("MobileNav — items and page dots", () => {
  it("has Map, My Location and Locations, in that order", () => {
    const order = ['id: "map"', 'id: "my-location"', 'id: "locations"'].map(
      (k) => nav.indexOf(k),
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(nav).toContain("href: mapHref");
    expect(nav).toContain("href: MY_LOCATION_HREF");
    expect(nav).toContain('href: "/locations"');
    expect(nav).toContain('? "Weather map"');
    expect(nav).toContain('ariaLabel: "All locations"');
  });

  it("marks the current page explicitly (Map never lights up on /explore)", () => {
    expect(nav).toContain("activeId={mobileNavActiveId(pathname)}");
    expect(nav).toContain('return "none";');
  });

  it("shows the place sequence as tappable LocationPager dots above the items, behind a harness boundary", () => {
    expect(nav).toContain("indicator={");
    expect(nav).toContain("<LocationPager");
    expect(nav).toMatch(/<MziziHarness\s+name="location-pager"/);
    expect(pager).toContain("<Link");
    expect(pager).toContain('aria-current={isActive ? "page" : undefined}');
    expect(pager).toContain("aria-label={name}");
    expect(pager).toContain(
      "h-[var(--touch-target-min)] min-w-[var(--touch-target-min)]",
    );
    expect(pager).toContain('method: "saved"');
  });

  it("labels use the 16px --text-nav-label token, not upstream's 10px", () => {
    expect(bottomNav).toContain("text-[length:var(--text-nav-label)]");
    expect(bottomNav).not.toContain("text-[10px]");
  });

  it("uses only token radii (the alignment guard skips src/components/ui/)", () => {
    // mzizi-alignment.test.ts exempts ui/ primitives; the vendored nav is
    // held to the same radius rule here instead.
    expect(bottomNav).not.toMatch(
      /\brounded(-(sm|md|lg|xl|2xl|3xl))?(?=[\s"`])/,
    );
    expect(bottomNav).not.toMatch(/rounded-\[\d/);
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
