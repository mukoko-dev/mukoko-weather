/**
 * The real site chrome, server-rendered (react-dom/server, no fake window or
 * navigator, no react-dom/client), for a matrix of routes: how many Quick
 * actions groups, bells and notifications centres a visitor's HTML actually
 * holds. The group is drawn by whatever draws the site header, and by the map
 * page itself where there is no header; this counts what is rendered rather
 * than asking a path predicate who should have rendered it, so two owners
 * disagreeing about a route (the not-found page of an unknown place's map had
 * a header AND a dock) show up as a count of two.
 *
 * Each route is rendered inside the real AppChrome, with the real page
 * component where one can render here (the map, its loader, the not-found
 * view, the display's loader and error boundary, an ordinary page shell) and a
 * plain stand-in where the page is only data (the embed's widget).
 */
import { PassThrough } from "node:stream";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToPipeableStream } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ pathname: "/" }));
const centre = vi.hoisted(() => ({ mounts: 0 }));
/** What the store reports instead of its own, so a test can force it open. */
const forced = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({
    push: () => undefined,
    replace: () => undefined,
    prefetch: () => undefined,
  }),
}));
// AuthKit's client needs the Next runtime; a signed-out visitor stands in.
vi.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: () => ({ user: null }),
}));
// The real store, read as it is, except for what a test forces: zustand reads
// its INITIAL state on the server, so a state set before the render would not
// reach a server render at all.
vi.mock("@/lib/store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/store")>();
  const read = (select?: (state: never) => unknown) => {
    const state = { ...real.useAppStore.getState(), ...forced.state };
    return select ? select(state as never) : state;
  };
  return {
    ...real,
    useAppStore: Object.assign(read, real.useAppStore),
  };
});
// The centre itself is not under test: a stand-in that counts every mount
// (the real one is lazy, so React has to resolve it for it to be counted).
vi.mock("@/components/notifications/NotificationsCentre", () => ({
  NotificationsCentre: () => {
    centre.mounts += 1;
    return createElement("div", { "data-centre-stub": "" });
  },
}));

import { AppChrome } from "./AppChrome";
import { NotFoundView } from "./NotFoundView";
import { PageShell } from "./PageShell";
import { MapDashboard } from "@/app/[location]/map/MapDashboard";
import MapLoading from "@/app/[location]/map/loading";
import LocationError from "@/app/[location]/error";
import DisplayError from "@/app/display/error";
import DisplayLoading from "@/app/display/loading";

/** Server-render `node` to the end (lazy components and Suspense resolved). */
function html(node: ReactNode): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const out = new PassThrough();
    out.on("data", (chunk: Buffer) => chunks.push(chunk));
    out.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    const { pipe } = renderToPipeableStream(node, {
      onAllReady() {
        pipe(out);
      },
      onError: reject,
    });
  });
}

const count = (out: string, needle: RegExp) => (out.match(needle) ?? []).length;
/** Quick actions groups: the toolbar role and its name, counted apart so a half-removed group shows up. */
const toolbars = (out: string) => count(out, /role="toolbar"/g);
const named = (out: string) => count(out, /aria-label="Quick actions"/g);
const bells = (out: string) => count(out, /data-notifications-trigger/g);
const centres = (out: string) => count(out, /data-centre-stub/g);
const slots = (out: string) => count(out, /data-quick-actions-slot/g);
const headers = (out: string) => count(out, /<header[\s>]/g);

const place = {
  slug: "harare",
  name: "Harare",
  lat: -17.83,
  lon: 31.05,
  country: "ZW",
  province: "Harare",
  tags: [],
  elevation: 1490,
} as never;

// PageShell's props type wants its children as a prop; a plain createElement
// call passes them as arguments (the rules of React forbid the prop form).
const Shell = PageShell as unknown as ComponentType<{ children?: ReactNode }>;
const page = () =>
  createElement(Shell, null, createElement("p", null, "content"));

interface Route {
  name: string;
  pathname: string;
  children: () => ReactNode;
  /** Quick actions groups in the HTML. */
  groups: 0 | 1;
  /** Whether the page has a site header at all. */
  header: boolean;
}

/** What each route renders, and how many groups it must hold. */
const ROUTES: Route[] = [
  {
    name: "the home page",
    pathname: "/",
    children: page,
    groups: 1,
    header: true,
  },
  {
    name: "a place page",
    pathname: "/harare",
    children: page,
    groups: 1,
    header: true,
  },
  {
    name: "a place sub-route",
    pathname: "/harare/forecast",
    children: page,
    groups: 1,
    header: true,
  },
  {
    name: "a plain page",
    pathname: "/releases",
    children: page,
    groups: 1,
    header: true,
  },
  {
    name: "/locations",
    pathname: "/locations",
    children: page,
    groups: 1,
    header: true,
  },
  {
    name: "/embed (the page about the widget)",
    pathname: "/embed",
    children: page,
    groups: 1,
    header: true,
  },
  {
    name: "the weather map",
    pathname: "/harare/map",
    children: () => createElement(MapDashboard, { location: place }),
    groups: 1,
    header: false,
  },
  {
    name: "the weather map's loader",
    pathname: "/harare/map",
    children: () => createElement(MapLoading),
    groups: 1,
    header: false,
  },
  {
    // notFound() under an immersive path: AppChrome stands back, and the
    // not-found view renders its own header, which brings the one group.
    name: "an UNKNOWN place's map route (the not-found view)",
    pathname: "/harere/map",
    children: () =>
      createElement(NotFoundView, {
        title: "Location not found",
        message: "We don't have weather data for that location yet.",
      }),
    groups: 1,
    header: true,
  },
  {
    name: "another path under the map's pattern that is not a place",
    pathname: "/explore/map",
    children: () =>
      createElement(NotFoundView, { title: "Not found", message: "No." }),
    groups: 1,
    header: true,
  },
  {
    // The route's error boundary renders no header and no group, today and
    // before this change alike (it is a bare page).
    name: "the map's error boundary",
    pathname: "/harare/map",
    children: () =>
      createElement(LocationError, {
        error: new Error("x"),
        reset: () => undefined,
      }),
    groups: 0,
    header: false,
  },
  {
    name: "an embedded widget (/embed/widget)",
    pathname: "/embed/widget",
    children: () => createElement("main", null, "widget"),
    groups: 0,
    header: true,
  },
  {
    name: "another embed view (/embed/anything)",
    pathname: "/embed/anything",
    children: () =>
      createElement(NotFoundView, { title: "Not found", message: "No." }),
    groups: 0,
    header: true,
  },
  {
    name: "the wall display's loader",
    pathname: "/display",
    children: () => createElement(DisplayLoading),
    groups: 0,
    header: false,
  },
  {
    name: "the wall display's error boundary",
    pathname: "/display",
    children: () =>
      createElement(DisplayError, {
        error: new Error("x"),
        reset: () => undefined,
      }),
    groups: 0,
    header: false,
  },
  {
    // AppChrome stands back on /display, so a page there that rendered its own
    // header would get SiteHeader: still no group on the kiosk.
    name: "the wall display, if a page there drew a site header",
    pathname: "/display",
    children: page,
    groups: 0,
    header: true,
  },
  {
    name: "a path under /display that is not the kiosk",
    pathname: "/display/other",
    children: () =>
      createElement(NotFoundView, { title: "Not found", message: "No." }),
    groups: 1,
    header: true,
  },
];

const render = (route: Route) => {
  nav.pathname = route.pathname;
  return html(createElement(AppChrome, null, route.children()));
};

beforeEach(() => {
  centre.mounts = 0;
  forced.state = {};
});

describe("the real chrome: how many Quick actions groups each route holds", () => {
  it.each(ROUTES)("$name: $groups group(s)", async (route) => {
    const out = await render(route);
    expect(toolbars(out), "toolbars").toBe(route.groups);
    expect(named(out), "named Quick actions").toBe(route.groups);
    expect(bells(out), "bells").toBe(route.groups);
    expect(count(out, /aria-label="Share /g), "Share").toBe(route.groups);
    expect(count(out, /aria-label="All locations"/g), "Locations").toBe(
      route.groups,
    );
    expect(headers(out) > 0, "has a site header").toBe(route.header);
    // The header leaves a slot for the group exactly when it draws one.
    if (route.header) expect(slots(out), "slot").toBe(route.groups);
  });

  it("never holds more than one group, on any route", async () => {
    for (const route of ROUTES) {
      expect(toolbars(await render(route)), route.name).toBeLessThanOrEqual(1);
    }
  });
});

describe("the real chrome: how many notifications centres open with the store forced open", () => {
  it.each(ROUTES)("$name: $groups centre(s)", async (route) => {
    forced.state = { notificationsOpen: true };
    const out = await render(route);
    // The centre mounts behind the one bell, and only there.
    expect(centres(out), "centres in the HTML").toBe(route.groups);
    expect(centre.mounts, "mounts").toBe(route.groups);
    expect(out).toContain(route.groups ? 'aria-expanded="true"' : "<");
  });
});
