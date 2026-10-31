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
const menu = readFileSync(resolve(__dirname, "PhoneMenu.tsx"), "utf-8");
const acct = readFileSync(
  resolve(__dirname, "../ui/app-account-menu.tsx"),
  "utf-8",
);
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

  it("has exactly one navigation landmark per list: no nav wraps the desktop nav", () => {
    // The header wrapper is a div; "Main navigation" is the only nav in it.
    expect(source).not.toContain('aria-label="Primary navigation"');
    expect(source.match(/<nav[\s>]/g)).toHaveLength(1);
    expect(source).toContain('aria-label="Main navigation"');
    // Nothing from the bottom bar's pager is a nav (it nests inside MziziBottomNav's nav).
    expect(pager.match(/<nav[\s>]/g)).toBeNull();
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

describe("Header — the phone menu is the Mzizi account menu, filled with the header's rows", () => {
  it("PhoneMenu is a thin wrapper around the vendored Mzizi app-account-menu (no custom menu left)", () => {
    expect(menu).toContain('from "@/components/ui/app-account-menu"');
    expect(menu).toContain("<AccountMenu");
    // The disclosure, outside-click, Escape and focus return are the Mzizi
    // component's; the wrapper keeps none of its own.
    expect(menu).not.toMatch(
      /document\.addEventListener|menuOpen|menuRef|menuButtonRef/,
    );
    expect(menu).not.toContain("mobile-more-menu");
  });

  it("the vendored component is a <details> disclosure with a per-instance id, a POST sign-out form and a documented header", () => {
    expect(acct).toContain("<details");
    expect(acct).toContain("<summary");
    expect(acct).toContain("const panelId = useId();");
    expect(acct).toContain("aria-controls={panelId}");
    expect(acct).toContain('method="post"');
    expect(acct).toContain("https://api.mzizi.dev/v1/ui/app-account-menu");
    expect(acct).toContain("780457ae94afd5229a78a5d7ba5146bda8260812");
    // Each deviation is listed in the header (numbered), like mzizi-bottom-nav.
    expect(acct).toMatch(/Local changes from upstream/);
    for (let n = 1; n <= 11; n++) expect(acct).toContain(` * ${n}. `);
  });

  it("closes on Escape (focus returns to the trigger), an outside click and a chosen row", () => {
    expect(acct).toContain('e.key !== "Escape"');
    expect(acct).toContain('querySelector<HTMLElement>("summary")?.focus()');
    expect(acct).toContain(
      'document.addEventListener("pointerdown", onPointerDown)',
    );
    expect(acct).toContain(
      'document.removeEventListener("pointerdown", onPointerDown)',
    );
    // iOS Safari synthesises no mouse events for a tap on a non-clickable
    // element, so a mousedown listener never fires there.
    expect(acct).not.toContain('"mousedown"');
    expect(acct).toContain('closest("a, [data-close-menu]")');
    // The two action rows opt in to closing; Notifications expands in place.
    expect(menu.match(/data-close-menu/g)).toHaveLength(2);
  });

  it("closes when focus moves to an element outside the menu, and ignores a null relatedTarget", () => {
    // Tab / Shift+Tab out of the open panel: relatedTarget is the next element.
    expect(acct).toContain("onBlur={(e) => {");
    expect(acct).toContain("const next = e.relatedTarget;");
    expect(acct).toContain(
      "next instanceof Node && !e.currentTarget.contains(next)",
    );
    // A null relatedTarget (a click on the panel's padding, the window losing
    // focus) must NOT close it: the guard requires a real Node.
    expect(acct).not.toMatch(/relatedTarget\s*(===|==|!==)\s*null/);
    // Escape still hands focus back to the trigger.
    expect(acct).toContain('querySelector<HTMLElement>("summary")?.focus()');
  });

  it("is mobile-only in the header, sitting inside the existing icon pill (ellipsis trigger)", () => {
    expect(source).toContain('<div className="relative sm:hidden">');
    expect(source).toContain("<PhoneMenu");
    expect(source).toContain('trigger="ellipsis"');
    expect(source).toContain('buttonClassName="bee"');
    expect(menu).toContain('"More options"');
  });

  it("lists the header's destinations from the shared list (Shamwari behind its flag)", () => {
    expect(menu).toContain("visibleHeaderDestinations(isFeatureEnabled)");
    expect(menu).toContain("destinations.map(");
    expect(source).toContain("visibleHeaderDestinations(isFeatureEnabled)");
    expect(source).toContain("destinations.map(");
  });

  it("has My Weather and Use my location rows that close the menu", () => {
    expect(menu).toMatch(
      /data-close-menu\s+onClick=\{\(\) => openMyWeather\(\)\}[\s\S]*?My Weather/,
    );
    expect(menu).toMatch(/void handleMyLocation\(\)[\s\S]*?Use my location/);
  });

  it("the Use my location item keeps the busy state and double-tap guard", () => {
    expect(menu).toContain("disabled={locating}");
    expect(menu).toContain("aria-busy={locating}");
    expect(menu).toContain("if (locating) return;");
  });

  it("rows are 48px and grouped under labelled sections (Account, Weather, Pages)", () => {
    expect(acct).toContain("min-h-[var(--touch-target-min)]");
    expect(menu).toContain("ACCOUNT_MENU_ROW_CLASS");
    for (const name of ["account", "weather", "pages"]) {
      expect(menu).toContain('groupLabel("' + name + '")');
    }
  });
});

describe("Header — nothing the header offers is lost in the phone menu", () => {
  const nav = readFileSync(
    resolve(__dirname, "../../lib/header-nav.ts"),
    "utf-8",
  );

  it("every header nav destination (from the shared list) is in the phone menu, flags included", async () => {
    const { HEADER_DESTINATIONS, visibleHeaderDestinations } =
      await import("@/lib/header-nav");
    // Both surfaces render the same function over the same list, so they
    // cannot drift; this pins that wiring and the list's content.
    expect(source).toContain("visibleHeaderDestinations(isFeatureEnabled)");
    expect(menu).toContain("visibleHeaderDestinations(isFeatureEnabled)");
    expect(HEADER_DESTINATIONS.map((d) => d.href)).toEqual([
      "/explore",
      "/shamwari",
      "/history",
      "/aviation",
    ]);
    expect(visibleHeaderDestinations(() => true)).toHaveLength(4);
    expect(visibleHeaderDestinations(() => false).map((d) => d.href)).toEqual([
      "/explore",
      "/history",
      "/aviation",
    ]);
    // The header must not hard-code a destination outside the shared list.
    for (const d of HEADER_DESTINATIONS) {
      expect(source, d.href).not.toContain(`href: "${d.href}"`);
    }
  });

  it("every action in the header source has its phone-menu counterpart", () => {
    // Derived from the header's own source: its internal links, its labelled
    // controls and its My Weather button.
    const headerHrefs = [...source.matchAll(/href="(\/[^"]*)"/g)]
      .map((m) => m[1])
      .filter((h) => h !== "/"); // "/" is the brand mark, not an action
    expect(headerHrefs.sort()).toEqual(["/auth/signin", "/profile"].sort());
    expect(menu).toContain('href="/profile"');
    expect(menu).toContain('signInHref="/auth/signin"');

    // Map: the header links mapHref (weatherMapHref) — the menu does too.
    expect(source).toContain("href={mapHref}");
    expect(source).toContain("weatherMapHref(mapSlug)");
    expect(menu).toContain("href={weatherMapHref(mapSlug)}");
    expect(menu).toContain("Choose a location for the weather map");

    // Notifications: the header's bell and the menu row show the same copy.
    expect(source).toContain('aria-label="Notifications"');
    expect(menu).toContain("Notifications");
    expect(source).toContain("{NOTIFICATIONS_EMPTY_TEXT}");
    expect(menu).toContain("{NOTIFICATIONS_EMPTY_TEXT}");
    expect(nav).toContain('"No notifications yet"');

    // My Weather and Use my location.
    expect(source).toContain("openMyWeather()");
    expect(menu).toContain("openMyWeather()");
    expect(menu).toContain("Use my location");
  });

  it("sign-out is the Mzizi POST form, handled by /auth/signout", () => {
    expect(menu).toContain('signOutAction="/auth/signout"');
    const route = readFileSync(
      resolve(__dirname, "../../app/auth/signout/route.ts"),
      "utf-8",
    );
    expect(route).toContain("export const POST");
    expect(route).toContain("isSameOrigin(request)");
    expect(route).toContain("status: 303");
    // The Location is relative: an absolute one built from request.url can be
    // http://localhost:PORT behind a TLS-terminating proxy. The behaviour is
    // pinned in src/app/auth/signout/signout-route.test.ts.
    expect(route).toContain('location: "/auth/signout"');
    expect(route).not.toContain("new URL(");
  });

  it("the hero's phone trigger is the profile button: photo, initials or the user icon", () => {
    expect(menu).toContain('trigger === "ellipsis"');
    expect(menu).toContain(
      "initials={authedUser ? initialsFor(authedUser) : undefined}",
    );
    expect(menu).toContain("imageUrl={authedUser?.profilePictureUrl ?? null}");
    expect(acct).toContain("isValidImageUrl(imageUrl)");
    expect(acct).toContain("<User size={20}");
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
    expect(menu).toContain('await import("@/lib/geolocation")');
    expect(menu).toContain("detectUserLocation({ autoCreate: true })");
  });

  it("selects the detected location and returns to the home page (no slug URL)", () => {
    expect(menu).toContain("setSelectedLocation(result.location.slug)");
    expect(menu).toContain('router.push("/")');
    expect(menu).not.toContain("router.push(`/${result.location.slug}`)");
  });

  it("only accepts a valid location slug from geolocation", () => {
    expect(menu).toContain("isLocationSlug(result.location.slug)");
  });

  it("falls back to the My Weather modal on denial or failure", () => {
    expect(menu).toMatch(/} else \{\s*openMyWeather\(\);/);
  });

  it("tracks geolocation_result and location_changed analytics events", () => {
    expect(menu).toContain('trackEvent("geolocation_result"');
    expect(menu).toContain('trackEvent("location_changed"');
    expect(menu).toContain('method: "geolocation"');
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
    expect(source).toContain(
      'import { currentLocationSlug } from "@/lib/current-slug"',
    );
    expect(source).toContain(
      "const mapSlug = currentLocationSlug(pathname, selectedLocation);",
    );
  });

  it("links to /{slug}/map when a location is known, otherwise to /explore", () => {
    expect(source).toContain("const mapHref = weatherMapHref(mapSlug);");
    expect(source).toContain("href={mapHref}");
    expect(source).toContain("Choose a location for the weather map");
  });
});

describe("Header — My Location button", () => {
  it("seeds the home page with the found place and refreshes it in place on /", () => {
    expect(menu).toContain("writeLastLocationCookie(result.location.slug)");
    expect(menu).toContain("new CustomEvent(CURRENT_LOCATION_EVENT");
    expect(menu).toContain('router.push("/")');
  });
});

describe("PhoneMenu — one menu, two homes", () => {
  const hero = readFileSync(
    resolve(__dirname, "../weather/CurrentConditions.tsx"),
    "utf-8",
  );

  it("is the header's phone menu and the hero's, from one component", () => {
    expect(source).toContain("<PhoneMenu");
    expect(hero).toContain("<PhoneMenu");
    expect(hero).toContain('buttonClassName="kestrel-round"');
    expect(hero).toContain('trigger="profile"');
  });

  it("lists the account (Account when signed in, Sign in otherwise)", () => {
    expect(menu).toContain('href="/profile"');
    expect(acct).toContain('signInLabel = "Sign in"');
  });
});

describe("Header over the sky hero", () => {
  it("is marked so CSS can hide it on phones and make it transparent from sm", () => {
    expect(source).toContain("data-site-header");
    expect(source).toContain('data-scrolled={isScrolled ? "" : undefined}');
    expect(css).toContain("body:has([data-sky-hero]) [data-site-header]");
    const phone = css.slice(css.indexOf("@media (max-width: 639.98px)"));
    expect(phone.slice(0, phone.indexOf("\n}\n"))).toContain("display: none");
  });

  it("keeps the bottom controls: only the <header> is hidden, never MobileNav", () => {
    expect(css).not.toMatch(/\[data-sky-hero\][^{]*MobileNav/);
    expect(source).toContain("<MobileNav");
  });

  it("gains its blurred surface only after scroll (unchanged)", () => {
    expect(source).toContain("bg-surface-base/70 backdrop-blur-xl");
  });
});

describe("Header over the sky: white text never reaches the popovers", () => {
  it("scopes the sky-ink override to the brand mark and desktop links, not the <header>", () => {
    const at = css.indexOf("[data-header-ink] {");
    expect(at).toBeGreaterThan(-1);
    // The selector that sets the text tokens ends in [data-header-ink].
    const sel = css.slice(
      css.lastIndexOf("body:has", at),
      at + "[data-header-ink]".length,
    );
    expect(sel).toContain("[data-site-header]:not([data-scrolled])");
    expect(sel).toMatch(/\[data-header-ink\]$/);
    // No rule sets the text tokens directly on the header root.
    expect(css).not.toMatch(
      /\[data-site-header\]:not\(\[data-scrolled\]\)\s*\{[^}]*--color-text-/,
    );
  });

  it("marks only the logo wrapper and the desktop nav as sky ink", () => {
    expect(source.match(/data-header-ink/g)).toHaveLength(2);
    expect(source).toMatch(
      /<div data-header-ink className="flex min-w-0 items-center">/,
    );
    expect(source).toMatch(
      /<nav\s+data-header-ink\s+className="hidden sm:flex/,
    );
  });

  it("keeps the notifications popover and the ⋯ menu outside the ink scopes, on a card surface", () => {
    const popover = source.indexOf(
      'aria-label="Notifications"\n                    className=',
    );
    const dialog = source.indexOf('role="dialog"');
    expect(dialog).toBeGreaterThan(-1);
    // The popover opens after both ink elements have closed (the action pill
    // follows the nav), and sits on bg-surface-card.
    expect(source.indexOf("</nav>")).toBeLessThan(dialog);
    expect(source.slice(dialog, dialog + 400)).toContain("bg-surface-card");
    expect(popover === -1 || popover > source.indexOf("</nav>")).toBe(true);
    expect(acct).toContain("bg-popover");
    expect(menu).not.toContain("data-header-ink");
    expect(acct).not.toContain("data-header-ink");
  });
});
