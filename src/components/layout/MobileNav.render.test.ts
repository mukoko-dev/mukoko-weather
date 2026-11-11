/**
 * The phone bottom bar rendered for real (react-dom/server): what a visitor's
 * HTML contains for no places, a few and many, on each kind of page, with the
 * account control (the avatar, the Mzizi account menu through PhoneMenu) as the
 * lane's last slot, at the far right of the bar, and My Location as the lane's
 * first chip, second from the left after Map. Effects do not run on the server, so the scroll-into-view
 * and fade are covered by the pure maths in src/lib/location-pager.test.ts
 * and, in a real browser, by the PR's runtime check.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalSlug as c } from "@/lib/slug-migration";

const nav = vi.hoisted(() => ({ pathname: "/" }));
const store = vi.hoisted(() => ({
  hiddenPresetSlugs: [] as string[],
  presetAnchor: null as unknown,
  locationLabels: {} as Record<string, string>,
  locationNames: {} as Record<string, string>,
  // What the account menu (PhoneMenu) reads.
  selectedLocation: "harare",
  openMyWeather: () => undefined,
  openNotifications: () => undefined,
  setSelectedLocation: () => undefined,
}));
const auth = vi.hoisted(() => ({
  user: null as null | Record<string, string | null>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));
vi.mock("@/lib/store", () => ({
  useAppStore: (select: (s: typeof store) => unknown) => select(store),
}));
// The real account menu is rendered; only the AuthKit client (it needs the
// Next runtime) is replaced by the signed-in user this test sets.
vi.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: () => ({ user: auth.user }),
}));
// Suggested places depend on a geographic anchor; these tests are about the
// places a person saved.
vi.mock("@/lib/location-presets", () => ({
  visiblePresetSlugs: () => [],
}));

import { MobileNav } from "./MobileNav";

function render(
  pathname: string,
  savedLocations: string[] = [],
  extra: Record<string, unknown> = {},
) {
  nav.pathname = pathname;
  return renderToStaticMarkup(
    createElement(MobileNav, {
      pathname,
      savedLocations,
      selectedLocation: "harare",
      mapHref: "/harare/map",
      hasMapLocation: true,
      ...extra,
    }),
  );
}

/** Every `<a ...>` opening tag in the markup. */
function anchors(html: string): string[] {
  return html.match(/<a\b[^>]*>/g) ?? [];
}
const current = (html: string) =>
  (html.match(/aria-current="page"/g) ?? []).length;

beforeEach(() => {
  store.hiddenPresetSlugs = [];
  store.presetAnchor = null;
  store.locationLabels = {};
  store.locationNames = {};
  auth.user = null;
});

/** The markup without the account menu (its panel holds links of its own). */
const withoutMenu = (html: string) =>
  html.replace(/<details[\s\S]*?<\/details>/, "");

/** The lane's chips: from their group to the account control. */
const placesOf = (html: string) =>
  html.slice(
    html.indexOf('aria-label="Places"'),
    html.indexOf('data-slot="account-menu"'),
  );

/**
 * The open tags a node sits inside, outermost first, as `<tag class="...">`
 * strings: a small stack walk over the markup (React emits void elements
 * without a closing tag and everything else with one).
 */
function ancestorsOf(html: string, nodeStart: number): string[] {
  const VOID = new Set(["img", "br", "hr", "input", "meta", "link"]);
  const stack: Array<{ name: string; tag: string }> = [];
  for (const m of html
    .slice(0, nodeStart)
    .matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*?(\/?)>/g)) {
    const [tag, close, name, selfClose] = m;
    if (close) {
      while (stack.length && stack.pop()!.name !== name);
    } else if (!selfClose && !VOID.has(name)) {
      stack.push({ name, tag });
    }
  }
  return stack.map((entry) => entry.tag);
}

describe("MobileNav render — one bar, one landmark", () => {
  it("renders exactly one <nav>, labelled, with no second pager pill", () => {
    const html = render("/", ["harare", "nairobi-ke"]);
    expect(html.match(/<nav\b/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Mobile navigation"');
    expect(html).not.toContain("mzizi-bottom-nav-indicator");
    expect(html).not.toContain("Location pages");
    expect(html).not.toContain("mzizi-bottom-nav-bar");
  });

  it("is phone-only and sits on the one floating surface", () => {
    const html = render("/");
    expect(html).toContain("sm:hidden");
    expect(html).toContain("bg-card/90");
    expect(html).toContain("backdrop-blur-xl");
    expect(html).toContain("h-[var(--mobile-nav-bar-height)]");
  });

  it("has Map first, then My Location and the places lane, and the account control last", () => {
    const html = render("/", ["harare"]);
    const map = html.indexOf('aria-label="Weather map"');
    const lane = html.indexOf('data-slot="mzizi-bottom-nav-lane"');
    const group = html.indexOf('aria-label="Places"');
    const home = html.indexOf('aria-label="My Location"');
    const account = html.indexOf('data-slot="account-menu"');
    expect(map).toBeGreaterThan(0);
    expect(lane).toBeGreaterThan(map);
    expect(group).toBeGreaterThan(lane);
    expect(home).toBeGreaterThan(group);
    expect(account).toBeGreaterThan(home);
    // Locations left the bar: it is the list link at the top right of the page.
    expect(html).not.toContain('aria-label="All locations"');
    expect(html).not.toContain('href="/locations"');
  });

  it("points Map at the map route of the location on screen, or at Explore with none", () => {
    expect(render("/")).toContain('href="/harare/map"');
    const none = render("/", [], {
      mapHref: "/explore",
      hasMapLocation: false,
    });
    expect(none).toContain('href="/explore"');
    expect(none).toContain(
      'aria-label="Choose a location for the weather map"',
    );
  });

  it("keeps Map a 48px target with the 16px label token", () => {
    const html = render("/");
    expect(
      html.match(/min-h-\[var\(--touch-target-min\)\]/g)!.length,
    ).toBeGreaterThanOrEqual(1);
    expect(html).toContain("text-[length:var(--text-nav-label)]");
  });
});

describe("MobileNav render — the account control, last in the lane", () => {
  it("is the Mzizi account menu: a <details> whose summary is a round 49px target, after every place", () => {
    const html = render("/", ["harare"]);
    expect(html.match(/<details\b/g)).toHaveLength(1);
    const summary = html.match(/<summary[^>]*>/)![0];
    expect(summary).toContain("plover");
    expect(summary).toContain("size-[var(--touch-target-min)]");
    expect(summary).toContain("rounded-full");
    expect(summary).toContain('aria-controls="');
    // Nothing of the places comes after it in the lane: it is the far right.
    expect(html.indexOf("<summary")).toBeGreaterThan(
      html.indexOf('aria-label="Saved places and suggestions"'),
    );
  });

  it("signed out it is the user icon named Account menu, with a Sign in row", () => {
    const html = render("/", ["harare"]);
    const summary = html.slice(
      html.indexOf("<summary"),
      html.indexOf("</summary>"),
    );
    expect(summary).toContain("lucide-user");
    expect(summary).toContain("Account menu");
    expect(summary).not.toContain("Account menu for");
    expect(html).toContain('href="/auth/signin"');
    expect(html).not.toContain("Sign out");
  });

  it("signed in it is the photo or the initials, named for the person, with Account and Sign out rows", () => {
    auth.user = {
      firstName: "Tendai",
      lastName: "Moyo",
      email: "t@example.com",
    };
    const initials = render("/", ["harare"]);
    const summary = initials.slice(
      initials.indexOf("<summary"),
      initials.indexOf("</summary>"),
    );
    expect(summary).toContain(">TM</span>");
    expect(summary).toContain("Account menu for Tendai Moyo");
    expect(initials).toContain('href="/profile"');
    expect(initials).toContain('action="/auth/signout"');

    auth.user = {
      firstName: "Tendai",
      email: "t@example.com",
      profilePictureUrl: "https://example.com/t.png",
    };
    const photo = render("/", ["harare"]);
    expect(photo).toContain('src="https://example.com/t.png"');
  });

  it("keeps every row of the account menu: My Weather, Use my location, the map, Notifications and the destinations", () => {
    const html = render("/", ["harare"]);
    for (const row of [
      "My Weather",
      "Use my location",
      "Weather map",
      "Notifications",
      "Explore",
      "History",
      "Aviation",
    ]) {
      expect(html, row).toContain(row);
    }
  });

  it("opens its panel UPWARD from the bar, against the bar: absolute, bottom-full, right-0, no fixed and no right gutter", () => {
    const html = render("/", ["harare"]);
    const panel = html.match(
      /<div[^>]*class="([^"]*)"[^>]*data-slot="account-menu-panel"/,
    )![1];
    const tokens = panel.split(/\s+/);
    expect(tokens).toContain("absolute");
    expect(tokens).toContain("bottom-full");
    expect(tokens).toContain("right-0");
    expect(tokens).toContain("mb-[var(--float-gap)]");
    expect(tokens).not.toContain("fixed");
    expect(tokens).not.toContain("left-0");
    expect(tokens).not.toContain("right-2");
    expect(tokens.some((t) => t.startsWith("sm:"))).toBe(false);
    // The width stays inside the bar's span; the height inside the room above the bar.
    expect(panel).toContain(
      "w-[min(18rem,calc(100vw-var(--float-left)-var(--float-right)))]",
    );
    expect(panel).toContain(
      "max-h-[calc(100dvh-var(--float-top)-var(--float-bottom)-var(--mobile-nav-bar-height)-var(--float-gap))]",
    );
    expect(tokens).toContain("overflow-y-auto");
  });

  it("hangs the panel from the bar: the bar is the nearest positioned ancestor and nothing between them is positioned, clipped or a containing block", () => {
    const html = render("/", ["harare"]);
    const ancestors = ancestorsOf(html, html.indexOf("<details"));
    // nav (the bar) > lane slot > the account/places wrapper > harness >
    // the details itself is the node.
    expect(ancestors[0]).toMatch(/^<nav\b/);
    expect(ancestors[0]).toContain("fixed");
    const between = ancestors.slice(1).join(" ");
    expect(between).not.toMatch(
      /\b(relative|absolute|fixed|sticky)\b|overflow-(hidden|clip|auto|scroll)|\b(transform|filter|backdrop-|contain-|will-change)/,
    );
    // The details is not itself positioned: the panel must not hang from the 49px trigger.
    const details = html.match(/<details[^>]*>/)![0];
    expect(details).not.toContain("relative");
  });
});

describe("MobileNav render — the places lane", () => {
  it("puts My Location first, then the places in order, each a real link", () => {
    const html = render("/", ["harare", "nairobi-ke", "lagos-ng"]);
    const hrefs = anchors(placesOf(html)).map(
      (a) => a.match(/href="([^"]*)"/)?.[1],
    );
    // Saved places are canonical URLs (#317).
    expect(hrefs).toEqual([
      "/",
      `/${c("harare")}`,
      `/${c("nairobi-ke")}`,
      `/${c("lagos-ng")}`,
    ]);
  });

  it("names the chips: My Location by label, places by their visible name", () => {
    const html = render("/", ["harare", "nairobi-ke"]);
    expect(html).toContain('aria-label="My Location"');
    expect(html).toContain(">Harare</span>");
    expect(html).toContain(">Nairobi</span>");
  });

  it("is never empty: with no places it is My Location alone, spelled out, and the account control stays", () => {
    const html = render("/");
    const chips = html.match(/class="lark[^"]*"/g) ?? [];
    expect(chips).toHaveLength(1);
    expect(html).toContain(">My Location</span>");
    expect(html).toContain('data-slot="account-menu"');
  });

  it("shows My Location as the glyph alone once places sit beside it", () => {
    const html = render("/explore", ["harare"]);
    expect(html).not.toContain(">My Location</span>");
    expect(html).toContain('aria-label="My Location"');
    // The glyph chip is one touch target wide through `min-w` alone; it keeps
    // `.lark`'s own 14px inline inset (no `px-0`, which `mzizi check` refuses).
    expect(html).toContain(
      'class="lark press-scale shrink-0 min-w-[var(--touch-target-min)]"',
    );
    // mzizi-spacing-exempt: names the class this asserts is gone
    expect(html).not.toContain("px-0");
  });

  it("pins My Location outside the scroller and lets the places scroll beside it", () => {
    const html = render("/", ["harare", "nairobi-ke"]);
    expect(html.indexOf('aria-label="My Location"')).toBeLessThan(
      html.indexOf("sanderling"),
    );
    // The account control follows the scroller: the far right of the bar.
    expect(html.indexOf("sanderling")).toBeLessThan(
      html.indexOf('data-slot="account-menu"'),
    );
    expect(html).not.toContain("sticky");
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("scrollbar-hide");
    expect(html).not.toContain("snap-");
  });

  it("gives every chip a 48px target through the .lark class, not a smaller hit area", () => {
    const html = render("/", ["harare", "a-b", "c-d"]);
    const chips = (html.match(/class="lark[^"]*"/g) ?? []).length;
    expect(chips).toBe(4);
    expect(html).not.toContain("h-8");
    expect(html).not.toContain("h-10");
  });

  it("renders up to MAX_PAGER_PLACES places, all reachable", () => {
    const many = Array.from({ length: 10 }, (_, i) => `place-${i}`);
    const html = render("/", many);
    expect((html.match(/class="lark[^"]*"/g) ?? []).length).toBe(11);
  });
});

describe("MobileNav render — aria-current is on exactly the current item", () => {
  it("is My Location on /", () => {
    const html = withoutMenu(render("/", ["harare", "nairobi-ke"]));
    expect(current(html)).toBe(1);
    const tag = anchors(html).find((a) => a.includes('aria-current="page"'))!;
    expect(tag).toContain('href="/"');
    expect(tag).toContain('aria-label="My Location"');
  });

  it("is the place's chip on its page", () => {
    const html = withoutMenu(
      render(`/${c("nairobi-ke")}`, ["harare", "nairobi-ke"]),
    );
    expect(current(html)).toBe(1);
    expect(anchors(html).find((a) => a.includes("aria-current"))).toContain(
      `href="/${c("nairobi-ke")}"`,
    );
    // A legacy URL a stored page can still show is the same place.
    expect(
      current(withoutMenu(render("/nairobi-ke", ["harare", "nairobi-ke"]))),
    ).toBe(1);
  });

  it("is the place's chip on a sub-route like its map", () => {
    const html = withoutMenu(
      render("/harare/map", ["harare"], { mapHref: "/harare/map" }),
    );
    expect(current(html)).toBe(1);
  });

  it("is nothing on /locations: the list link is at the top of the page, not in the bar", () => {
    const html = withoutMenu(render("/locations", ["harare"]));
    expect(current(html)).toBe(0);
  });

  it("is nothing on /explore (Map never lights up there, even though it links to Explore)", () => {
    const html = withoutMenu(
      render("/explore", ["harare"], {
        mapHref: "/explore",
        hasMapLocation: false,
      }),
    );
    expect(current(html)).toBe(0);
  });

  it("marks the account menu's own row for the page, not the bar's items", () => {
    // The destinations inside the menu carry aria-current for their own page.
    const html = render("/explore", ["harare"], {
      mapHref: "/explore",
      hasMapLocation: false,
    });
    const panel = html.slice(
      html.indexOf("<details"),
      html.indexOf("</details>"),
    );
    expect(panel).toMatch(
      /<a[^>]*aria-current="page"[^>]*href="\/explore"|<a[^>]*href="\/explore"[^>]*aria-current="page"/,
    );
  });

  it("marks the active chip with the lark class that the CSS fills, not a colour in markup", () => {
    const html = render("/", ["harare"]);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(html).not.toContain("style=");
  });
});

describe("MobileNav render — what a chip says", () => {
  it("shows the person's own label, then a name seen this session, then the slug's name", () => {
    store.locationLabels = { [c("harare")]: "Home" };
    store.locationNames = { [c("nairobi-ke")]: "Nairobi CBD" };
    const html = render("/", ["harare", "nairobi-ke", "lagos-ng"]);
    expect(html).toContain(">Home</span>");
    expect(html).toContain(">Nairobi CBD</span>");
    expect(html).toContain(">Lagos</span>");
    expect(html).not.toContain(">Harare</span>");
  });

  it("reads a coordinate spot as its coordinates, never as slug fragments", () => {
    const html = render("/", ["12-35n-45-62e--ksy4dd7"]);
    expect(html).toMatch(/>\d{1,2}\.\d{2}°[NS] \d{1,3}\.\d{2}°[EW]<\/span>/);
    // The slug is in the href; the TEXT of the chip is the coordinates.
    const text = [
      ...html.matchAll(/<span class="truncate">([^<]*)<\/span>/g),
    ].map((m) => m[1]);
    expect(text.some((t) => /62e|35n/.test(t))).toBe(false);
  });

  it("names the places list so My Location (the link before it) is not counted as one of its items", () => {
    const html = render("/", ["harare"]);
    expect(html).toContain('aria-label="Saved places and suggestions"');
  });

  it("gives the chips the press feedback class", () => {
    expect(render("/", ["harare"])).toContain("lark press-scale");
  });
});
