/**
 * Tests for Header — the mobile navigation island (a floating, centred pill:
 * map / My Location and the places lane / the account control, matching the
 * mukoko-news island), the account menu behind the bar's last slot that holds
 * the destinations the island does not show, and Locations, the round list
 * link in the header's pill (owner, 2026-11-11: the avatar is the far right of
 * the bar, My Location is second from the left, Locations is at the top right)
 * and now the Quick actions group, which the header mounts once beside itself
 * (src/components/layout/QuickActions.tsx; its render and tone are held by
 * QuickActions.render.test.ts and src/lib/sky-hero.test.ts).
 * Desktop header stays as it was. Reads source directly (no
 * DOM renderer needed for structural checks).
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
/** The group and the bell the header mounts (one mount, for every page). */
const group = readFileSync(resolve(__dirname, "QuickActions.tsx"), "utf-8");
const bell = readFileSync(
  resolve(__dirname, "NotificationsButton.tsx"),
  "utf-8",
);
/** The notifications centre: the sheet on phones, the popover under the bell. */
const centre = readFileSync(
  resolve(__dirname, "../notifications/NotificationsCentre.tsx"),
  "utf-8",
);
const css = readFileSync(resolve(__dirname, "../../app/globals.css"), "utf-8");
/** The body of one `@layer components` rule in globals.css. */
function rule(name: string): string {
  const m = css.match(new RegExp(`\\.${name} \\{([^}]*)\\}`));
  return m ? m[1] : "";
}

const lane = readFileSync(resolve(__dirname, "PlaceLane.tsx"), "utf-8");
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
    // Nothing from the bottom bar's places lane is a nav (it nests inside MziziBottomNav's nav).
    expect(lane.match(/<nav[\s>]/g)).toBeNull();
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
    // The same inset on the sides and the bottom, from the one float grid.
    expect(bottomNav).toContain(
      "fixed left-[var(--float-left)] right-[var(--float-right)]",
    );
    expect(bottomNav).toContain("bottom-[var(--float-bottom)]");
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

  it("is 4.5rem tall; --mobile-nav-clearance is the bar plus the lift, the safe area and a breath", () => {
    expect(bottomNav).toContain("h-[var(--mobile-nav-bar-height)]");
    expect(css).toContain("--mobile-nav-bar-height: 4.5rem;");
    // The lift is the grid's bottom (inset plus the safe area), so the bar
    // sits as far from the bottom edge as from the sides, and there is no
    // second token for it.
    expect(css).not.toContain("--mobile-nav-inset");
    expect(css).toContain("--float-inset: 1rem;");
    // The inset plus a small lift (owner, 2026-11-04), safe area included.
    expect(css.replace(/\s+/g, " ")).toContain(
      "--float-bottom: calc( env(safe-area-inset-bottom, 0px) + var(--float-inset) + var(--float-lift) );",
    );
    expect(css.replace(/\s+/g, " ")).toContain(
      "--mobile-nav-clearance: calc( var(--float-bottom) + var(--mobile-nav-bar-height) + 0.5rem );",
    );
  });

  it("gives the pinned items one preset width, wide enough for the longest label (owner, 2026-11-05; Map alone since 2026-11-11)", () => {
    expect(css).toContain("--mobile-nav-item-width: 4rem;");
    expect(bottomNav).toContain("w-[var(--mobile-nav-item-width)]");
    // Rem, so it follows the label's text size; the real browser check
    // (scripts/browser-check/bottom-bar.mjs) measures that "Map" fits.
    expect(css).toMatch(/--mobile-nav-item-width:\s*[\d.]+rem;/);
  });

  it("is in proportion (owner, 2026-11-04): 14px labels, 18px icons, pill-sized targets, 8px between them", () => {
    // At 16px labels and 21px icons the content filled the 64px bar edge to
    // edge: 56px of item in 64px, and chips 48px in 64px, with 4px between.
    expect(css).toContain("--text-nav-label: 0.875rem;");
    expect(css).not.toContain("--text-nav-label: 1rem;");
    expect(bottomNav).toContain("size-[18px]");
    expect(bottomNav).not.toContain("size-[21px]");
    // A pinned item is a pill about as tall as a chip, not a bar-high oval
    // (its focus ring and hover follow its shape); the bar-high part is the
    // tappable area, from .plover.
    const link = bottomNav.match(/"(plover [^"]*)",\s*hasLane/);
    expect(link).not.toBeNull();
    expect(link?.[1]).toContain("min-h-[var(--touch-target-min)]");
    expect(link?.[1]).not.toMatch(/(^|\s)h-full(\s|$)/);
    expect(bottomNav).toContain(
      '"gap-[var(--float-gap)] px-[var(--float-gap)]"',
    );
  });

  it("every target's tappable area is the bar's height, derived from the token, and fits inside the bar", () => {
    // One rule serves the pinned items (.plover) and the lane's chips (.lark).
    const hit = css.match(/\.plover::after,\s*\.lark::after\s*\{([^}]*)\}/);
    expect(hit).not.toBeNull();
    const body = hit?.[1] ?? "";
    // Stretched to exactly the bar, centred on the link: no hard-coded px or
    // rem guess at the bar's size, so changing the token moves the area too.
    expect(body).toContain(
      "inset-block: calc((100% - var(--mobile-nav-bar-height)) / 2);",
    );
    expect(body).toMatch(/inset-inline:\s*0;/);
    // The link's own box is a touch target tall and its content fits the bar,
    // so the area is an extension and never a shrink.
    const bar = css.match(/--mobile-nav-bar-height:\s*([\d.]+)rem;/);
    const touch = css.match(/--target-floor:\s*(\d+)px;/);
    expect(bar).not.toBeNull();
    expect(touch).not.toBeNull();
    expect(Number(bar?.[1]) * 16).toBeGreaterThan(Number(touch?.[1]));
    expect(rule("lark")).toContain("min-h-[var(--touch-target-min)]");
    // Both kinds of target carry it.
    expect(bottomNav).toMatch(/"plover relative /);
  });

  it("the current item is a soft pill fill (Apple's tab bars), not a line on the bar's top edge", () => {
    // No accent bar span and no hand-set colour: the look is one shared rule.
    const code = bottomNav.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain("h-[2.5px]");
    expect(code).not.toContain("text-[var(--brand-accent");
    expect(bottomNav).not.toContain("-top-[3px]");
    // The rule serves a pinned item and a lane chip alike: ONE "you are here".
    const at = css.indexOf(
      '.plover:is([aria-current]:not([aria-current="false"])),',
    );
    expect(at).toBeGreaterThan(-1);
    const rule = css.slice(at, css.indexOf("}", at));
    expect(rule).toContain(
      '.lark:is([aria-current]:not([aria-current="false"]))',
    );
    expect(rule).toContain("bg-container-cobalt");
    expect(rule).toContain("text-on-container-cobalt");
  });

  it("is ONE surface: the nav landmark is the pill, with no second pill and no leftover tokens", () => {
    const code = bottomNav.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code.match(/FLOATING_SURFACE/g)).toHaveLength(2); // the const and its one use
    expect(code).not.toContain("indicator");
    expect(code).not.toContain("--mobile-nav-gap");
    expect(code).not.toContain("--mobile-nav-height");
    expect(code).not.toContain("flex-col items-center gap-");
    expect(css).not.toContain("--mobile-nav-gap");
    expect(css).not.toContain("--mobile-nav-height");
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

describe("MobileNav — pinned items and the places lane", () => {
  it("pins Map at the start and nothing at the end, with the lane after it", () => {
    expect(nav.indexOf('id: "map"')).toBeGreaterThan(0);
    expect(nav).toContain("leading={leading}");
    expect(nav).not.toContain("trailing");
    expect(nav).toContain("lane={");
    // My Location is the lane's first chip, the account control the lane's last
    // slot and Locations a link at the top of the page: none is a bar item.
    expect(nav).not.toContain('id: "my-location"');
    expect(nav).not.toContain('id: "account"');
    expect(nav).not.toContain('id: "locations"');
    expect(nav).toContain("href: mapHref");
    expect(nav).not.toContain('href: "/locations"');
    expect(nav).toContain('? "Weather map"');
  });

  it("marks no pinned item as current (Map never lights up on /explore)", () => {
    expect(nav).toContain('activeId="none"');
    expect(nav).not.toContain("mobileNavActiveId");
  });

  it("shows the place sequence as tappable chips in the lane, behind a harness boundary that keeps a My Location link", () => {
    expect(nav).toContain("<PlaceLane");
    expect(nav).toMatch(/<MziziHarness\s+name="place-lane"/);
    expect(nav).toContain("fallback={<LaneFallback />}");
    expect(nav).not.toContain("LocationPager");
    expect(lane).toContain("<Link");
    expect(lane).toContain('aria-current={isActive ? "page" : undefined}');
    expect(lane).toContain("trackPlaceChange(chip.href, chip.slug, from)");
    // The chips are .lark: one touch target tall (see globals.css).
    expect(rule("lark")).toContain("min-h-[var(--touch-target-min)]");
  });

  it("ends the lane with the account control (the avatar), behind its own harness boundary that keeps a profile link", () => {
    expect(nav).toContain(
      'import { PhoneMenu } from "@/components/layout/PhoneMenu"',
    );
    expect(nav).toMatch(/<MziziHarness\s+name="account-menu"/);
    expect(nav).toContain("fallback={<AccountFallback />}");
    expect(nav).toContain("<PhoneMenu buttonClassName={ACCOUNT_SLOT_CLASS} />");
    // The places lane comes first, then the account control at the far right.
    expect(nav.indexOf("<PlaceLane")).toBeLessThan(nav.indexOf("<PhoneMenu"));
    // A round pinned target in the bar's own look (.plover), one touch target.
    const slot = nav.match(/ACCOUNT_SLOT_CLASS =\s*"([^"]*)"/);
    expect(slot).not.toBeNull();
    expect(slot![1]).toContain("plover");
    expect(slot![1]).toContain("size-[var(--touch-target-min)]");
    expect(slot![1]).toContain("rounded-full");
  });

  it("labels use the 14px (Mzizi body-sm) --text-nav-label token, not upstream's 10px or the 16px that read as too large", () => {
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
    // First vendored at 780457ae, re-checked against registry v4.26.5.
    expect(acct).toContain("780457ae94afd5229a78a5d7ba5146bda8260812");
    expect(acct).toContain("v4.26.5");
    expect(acct).toContain("bcd07b08f21b311fc1e7acacad65b40fa0615709");
    // Each deviation is listed in the header (numbered), like mzizi-bottom-nav.
    expect(acct).toMatch(/Local changes from upstream/);
    for (let n = 1; n <= 13; n++) expect(acct).toContain(` * ${n}. `);
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
    // The three action rows (My Weather, Use my location, Notifications) opt
    // in to closing: each opens something of its own (a modal, the GPS flow,
    // the notifications sheet) and the menu is out of the way by then.
    expect(menu.match(/data-close-menu/g)).toHaveLength(3);
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

  it("is no longer in the header: its ⋯ slot in the pill is Locations, and the menu opens from the bar", () => {
    // The ⋯ trigger and its "More options" name are gone with the move.
    expect(source).not.toContain("PhoneMenu");
    expect(source).not.toContain('trigger="ellipsis"');
    expect(menu).not.toContain("More options");
    expect(menu).not.toContain("Ellipsis");
    // Locations is the Quick actions group's third control, not the header's.
    expect(group).toContain("<LocationsLink");
    expect(source).not.toContain("<LocationsLink");
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

  it("rows are 49px and grouped under labelled sections (Account, Weather, Pages)", () => {
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

    // Notifications: the group's bell and the menu row call themselves the
    // same thing and open the SAME centre (the store's openNotifications).
    expect(bell).toContain("NOTIFICATIONS_LABEL");
    expect(menu).toContain("{NOTIFICATIONS_LABEL}");
    expect(nav).toContain('export const NOTIFICATIONS_LABEL = "Notifications"');
    expect(bell).toContain("openNotifications");
    expect(menu).toContain("openNotifications()");
    // The old "No notifications yet" stub is gone from both.
    expect(source).not.toContain("No notifications yet");
    expect(bell).not.toContain("No notifications yet");
    expect(menu).not.toContain("No notifications yet");
    expect(nav).not.toContain("No notifications yet");

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

  it("the bar's trigger is the account avatar: photo, initials or the user icon", () => {
    // PhoneMenu passes no trigger node, so the Mzizi component draws its own.
    expect(menu).not.toContain("trigger={");
    expect(menu).toContain(
      "initials={authedUser ? initialsFor(authedUser) : undefined}",
    );
    expect(menu).toContain("imageUrl={authedUser?.profilePictureUrl ?? null}");
    expect(acct).toContain("isValidImageUrl(imageUrl)");
    expect(acct).toContain("<User size={20}");
  });

  it("opens its panel upward from the bar", () => {
    expect(menu).toContain('panelPlacement="above"');
    expect(acct).toContain('panelPlacement = "below"');
  });
});

describe("Header — the Quick actions group (one group on every page)", () => {
  it("mounts the group once, beside <header>, and leaves the row room for it", () => {
    expect(source).toContain(
      'import { QuickActions } from "@/components/layout/QuickActions"',
    );
    expect(source.match(/<QuickActions/g)).toHaveLength(1);
    // The slot is the group's own width and height, from its tokens.
    expect(source).toContain("data-quick-actions-slot");
    expect(source).toContain(
      "h-[var(--hadeda-height)] w-[var(--hadeda-width)]",
    );
    // No pill, toolbar or bell of its own is left in the header.
    expect(source).not.toContain('role="toolbar"');
    expect(source).not.toContain("rounded-full bg-primary p-0.5");
    expect(source).not.toContain("BellIcon");
    expect(source).not.toContain("useAlertBadge");
    expect(source).not.toContain("NotificationsBoundary");
  });

  it("asks for the auto tone, and solid once its own surface is behind the group (scrolled, from `sm`)", () => {
    expect(source).toContain('tone={isScrolled && !phone ? "solid" : "auto"}');
    expect(source).toContain("const phone = useMediaQuery(PHONE_QUERY);");
  });

  it("adds the account icon from `md` and Map from `lg` after the three (the bottom bar holds them on a phone)", () => {
    const extra = source.slice(source.indexOf("extra={"));
    expect(extra).toContain("href={mapHref}");
    expect(extra.indexOf("href={mapHref}")).toBeLessThan(
      extra.indexOf("{authedUser ? ("),
    );
    // What the row can hold beside the brand and the nav, measured: Map waits
    // for 1024px, the account icon for 768px (globals.css has the numbers).
    expect(extra).toContain('className="bee hidden lg:flex"');
    expect(extra).toContain('className="bee hidden overflow-hidden md:flex"');
    const signIn = extra.slice(extra.indexOf('aria-label="Sign in"'));
    expect(signIn.slice(0, 120)).toContain('className="bee hidden md:flex"');
    // Their icons take the group's ink (the pill's or the sky's), no colour of their own.
    expect(extra).not.toContain("text-primary-foreground");
  });

  it("keeps the desktop text nav, closer together below `lg`, and the wordmark only from `md`", () => {
    expect(source).toContain('aria-label="Main navigation"');
    expect(source).toContain(
      'className="hidden sm:flex items-center gap-4 lg:gap-6"',
    );
    expect(source).toContain(
      '<MukokoLogo wordmarkClassName="hidden md:inline" />',
    );
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

describe("The group's bell opens the notifications centre (issue #95, #289)", () => {
  it("announces as a dialog, not a menu (it has no menuitems)", () => {
    expect(centre).toContain('role="dialog"');
    expect(centre).not.toContain('role="menu"');
    expect(bell).toContain('aria-haspopup="dialog"');
    expect(menu).toContain('aria-haspopup="dialog"');
  });

  it("closes on Escape and returns focus to the bell button", () => {
    expect(centre).toContain('e.key !== "Escape"');
    expect(centre).toContain("NOTIFICATIONS_TRIGGER_ATTR");
    expect(centre).toContain(".focus()");
    // The bell carries the attribute the centre looks for.
    expect(bell).toContain("data-notifications-trigger");
  });

  it("cleans up both the outside-press and keydown listeners", () => {
    expect(centre).toContain(
      'document.removeEventListener("pointerdown", onPointerDown)',
    );
    expect(centre).toContain(
      'document.removeEventListener("keydown", onKeyDown)',
    );
    // iOS Safari sends no mouse events for a tap on a non-clickable element.
    expect(centre).not.toContain('"mousedown"');
  });

  it("is mounted on demand, behind the store's notificationsOpen, and lazily loaded", () => {
    expect(bell).toContain("const NotificationsCentre = lazy(");
    expect(bell).toContain("{notificationsOpen && (");
    expect(bell).toContain("<NotificationsCentre anchorRef={anchorRef} />");
    expect(source).not.toContain("NotificationsCentre");
  });

  it("is isolated: a failed chunk or a render error never reaches the page's error boundary", () => {
    expect(bell).toContain(
      "<NotificationsBoundary onClose={closeNotifications}>",
    );
    // The boundary sits outside the Suspense that loads the lazy centre.
    expect(bell.indexOf("<NotificationsBoundary")).toBeLessThan(
      bell.indexOf("<Suspense>"),
    );
    expect(bell.indexOf("<Suspense>")).toBeLessThan(
      bell.indexOf("<NotificationsCentre anchorRef"),
    );
    const boundary = readFileSync(
      resolve(__dirname, "../notifications/NotificationsBoundary.tsx"),
      "utf-8",
    );
    expect(boundary).toContain("static getDerivedStateFromError");
    expect(boundary).toContain('role="alert"');
    expect(boundary).toContain("reportErrorToAnalytics(");
    expect(boundary).toContain("this.props.onClose");
    expect(boundary).toContain("impala-sm");
  });

  it("shows a dot with the count in the bell's name, never the count alone", () => {
    expect(bell).toContain("useAlertBadge()");
    expect(bell).toContain("data-alert-dot");
    expect(bell).toMatch(/alertCount === 1 \? "alert" : "alerts"/);
    // The dot is decorative.
    expect(bell).toMatch(/aria-hidden="true"\s+data-alert-dot/);
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

describe("PhoneMenu and LocationsLink — the avatar is the bar's far right, Locations the top right", () => {
  const hero = readFileSync(
    resolve(__dirname, "../weather/CurrentConditions.tsx"),
    "utf-8",
  );
  const link = readFileSync(resolve(__dirname, "LocationsLink.tsx"), "utf-8");

  it("the account menu has one home, the bar's last slot: neither the header nor the hero mounts it", () => {
    expect(nav).toContain("<PhoneMenu");
    expect(source).not.toContain("<PhoneMenu");
    expect(hero).not.toContain("PhoneMenu");
  });

  it("Locations is one component with one home: the third control of the Quick actions group", () => {
    expect(group.match(/<LocationsLink/g)).toHaveLength(1);
    expect(source).not.toContain("<LocationsLink");
    expect(hero).not.toContain("<LocationsLink");
    // It is the group's round .bee control, like Share and Notifications.
    expect(group).toContain('<LocationsLink className="bee" />');
    // Nobody hand-rolls the list link, and My Location is not up there.
    expect(source).not.toContain("ListIcon");
    expect(group).not.toContain("ListIcon");
    expect(hero).not.toMatch(/<Link\b[^>]*href="\/locations"/);
    expect(source).not.toContain("MyLocationLink");
    expect(hero).not.toContain("MyLocationLink");
  });

  it("is a plain real link to /locations named All locations, current on the list", () => {
    expect(link).toContain("<Link");
    expect(link).toContain("href={LOCATIONS_HREF}");
    expect(link).toContain('export const LOCATIONS_HREF = "/locations"');
    expect(link).toContain("aria-label={LOCATIONS_LABEL}");
    expect(link).toContain('aria-current={current ? "page" : undefined}');
    expect(link).toContain("const current = pathname === LOCATIONS_HREF;");
    // /locations is not a place: no place-stage hand-over.
    expect(link).not.toContain("handlePlaceLinkClick");
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

  it("hides only the <header> on phones: the Quick actions group is its sibling, so it stays, clear, over the sky", () => {
    expect(source.indexOf("<QuickActions")).toBeGreaterThan(
      source.indexOf("</header>"),
    );
    expect(css).not.toMatch(
      /\[data-sky-hero\][^{]*\.hadeda[^{]*\{[^}]*display:\s*none/,
    );
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
    // The popover is rendered by the centre, inside the bell's wrapper, in the
    // group: outside the <header> and its ink elements altogether.
    expect(source).not.toContain("<NotificationsCentre");
    expect(bell).toContain("<NotificationsCentre");
    expect(bell).not.toContain("data-header-ink");
    const dialog = centre.indexOf('role="dialog"');
    expect(dialog).toBeGreaterThan(-1);
    expect(centre.slice(dialog, dialog + 900)).toContain("bg-surface-card");
    expect(acct).toContain("bg-popover");
    expect(centre).not.toContain("data-header-ink");
    expect(menu).not.toContain("data-header-ink");
    expect(acct).not.toContain("data-header-ink");
  });
});
