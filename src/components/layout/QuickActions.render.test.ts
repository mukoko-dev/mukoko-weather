/**
 * The Quick actions group rendered for real (react-dom/server): the same three
 * controls, in the same order, with the same names, icons and 49px class, on
 * every page, and what the page's tone and placement put on it. Effects do not
 * run on the server, so the IntersectionObserver is covered by
 * src/lib/sky-hero.test.ts and, in a real browser, by
 * scripts/browser-check/quick-actions.mjs.
 */
import { PassThrough } from "node:stream";
import { createElement, type ReactNode } from "react";
import { renderToPipeableStream, renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ pathname: "/harare" }));
const alerts = vi.hoisted(() => ({ count: 0 }));
const store = vi.hoisted(() => ({
  notificationsOpen: false,
  openNotifications: () => undefined,
  closeNotifications: () => undefined,
}));
const centre = vi.hoisted(() => ({ mounts: 0 }));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: () => undefined }),
}));
vi.mock("@/lib/store", () => ({
  useAppStore: (select: (s: typeof store) => unknown) => select(store),
}));
vi.mock("@/lib/use-alerts", () => ({ useAlertBadge: () => alerts.count }));
// A stand-in for the lazy centre that counts every mount.
vi.mock("@/components/notifications/NotificationsCentre", () => ({
  NotificationsCentre: () => {
    centre.mounts += 1;
    return createElement("div", { "data-centre-stub": "" });
  },
}));

import { QuickActions, QUICK_ACTIONS_LABEL } from "./QuickActions";

/** Server-render `node` to the end (the lazy centre and Suspense resolved). */
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

function render(props: Record<string, unknown> = {}, pathname = "/harare") {
  nav.pathname = pathname;
  return renderToStaticMarkup(createElement(QuickActions, props));
}

/** The accessible names of the group's controls, in document order. */
function names(html: string): string[] {
  return [...html.matchAll(/<(?:a|button)\b[^>]*aria-label="([^"]*)"/g)].map(
    (m) => m[1],
  );
}

beforeEach(() => {
  alerts.count = 0;
  store.notificationsOpen = false;
  centre.mounts = 0;
});

describe("QuickActions: Share, Notifications, Locations, in that order", () => {
  it("is a toolbar named Quick actions", () => {
    const html = render();
    expect(QUICK_ACTIONS_LABEL).toBe("Quick actions");
    expect(html).toMatch(
      /^<div[^>]*role="toolbar"[^>]*aria-label="Quick actions"/,
    );
    expect(html).toContain("data-quick-actions");
  });

  it("holds exactly three controls: Share, then Notifications, then Locations", () => {
    expect(names(render())).toEqual([
      "Share this page",
      "Notifications",
      "All locations",
    ]);
  });

  it("is the same three controls on every page, in every place the app puts the group", () => {
    const pages = [
      "/",
      "/harare",
      "/harare/forecast",
      "/locations",
      "/explore",
      "/releases",
      "/harare/map",
    ];
    for (const pathname of pages) {
      expect(names(render({}, pathname)), pathname).toEqual([
        "Share this page",
        "Notifications",
        "All locations",
      ]);
    }
    for (const placement of ["header", "float"]) {
      expect(names(render({ placement })), placement).toHaveLength(3);
    }
    for (const tone of ["clear", "solid", "auto"]) {
      expect(names(render({ tone })), tone).toHaveLength(3);
    }
  });

  it("gives every control the same round 49px class (.bee) and a 20px icon", () => {
    const html = render();
    const controls = html.match(/<(?:a|button)\b[^>]*class="bee[^"]*"/g) ?? [];
    expect(controls).toHaveLength(3);
    expect(html.match(/<svg[^>]*width="20"[^>]*height="20"/g)).toHaveLength(3);
    // Every icon is decorative: the control carries the name.
    expect(html.match(/<svg[^>]*aria-hidden="true"/g)).toHaveLength(3);
  });

  it("links Locations to /locations and marks it current there, and only there", () => {
    const link = (html: string) =>
      html.match(/<a[^>]*aria-label="All locations"[^>]*>/)![0];
    expect(link(render())).toContain('href="/locations"');
    expect(link(render())).not.toContain("aria-current");
    expect(link(render({}, "/locations"))).toContain('aria-current="page"');
    expect(link(render({}, "/harare/map"))).not.toContain("aria-current");
  });

  it("opens notifications from a button that says it opens a dialog, with no centre mounted until then", () => {
    const html = render();
    const bell = html.match(/<button[^>]*data-notifications-trigger[^>]*>/)![0];
    expect(bell).toContain('aria-haspopup="dialog"');
    expect(bell).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="dialog"');
  });

  it("shows the alert dot and puts the count in the name, never the dot alone", () => {
    expect(render()).not.toContain("data-alert-dot");
    alerts.count = 1;
    let html = render();
    expect(names(html)[1]).toBe("Notifications, 1 alert");
    expect(html).toMatch(/aria-hidden="true"[^>]*data-alert-dot/);
    alerts.count = 3;
    html = render();
    expect(names(html)[1]).toBe("Notifications, 3 alerts");
  });

  it("puts anything extra after the three, in the same pill", () => {
    const html = render({
      extra: createElement("a", { "aria-label": "Weather map", href: "/x" }),
    });
    expect(names(html)).toEqual([
      "Share this page",
      "Notifications",
      "All locations",
      "Weather map",
    ]);
    expect(html.match(/role="toolbar"/g)).toHaveLength(1);
  });
});

describe("QuickActions: tone and placement", () => {
  it("asks for the auto tone and the header placement by default", () => {
    const html = render();
    expect(html).toContain('data-tone="auto"');
    expect(html).toContain('data-placement="header"');
    // Before the page has said anything, the sky is taken to be behind it.
    expect(html).not.toContain("data-past-sky");
  });

  it("carries the tone and placement it was given, for the CSS to read", () => {
    expect(render({ tone: "solid" })).toContain('data-tone="solid"');
    expect(render({ tone: "clear" })).toContain('data-tone="clear"');
    expect(render({ placement: "float" })).toContain('data-placement="float"');
  });

  it("is the one group class, with no inline style", () => {
    const html = render();
    expect(html).toContain('class="hadeda"');
    expect(html).not.toContain("style=");
  });
});

describe("QuickActions: the notifications centre, counted when it is rendered", () => {
  it("mounts no centre while the store says closed", async () => {
    const out = await html(createElement(QuickActions));
    expect(centre.mounts).toBe(0);
    expect(out).not.toContain("data-centre-stub");
    expect(out).toContain('aria-expanded="false"');
  });

  it("mounts exactly one centre while the store says open, under the bell's own wrapper (its anchor)", async () => {
    store.notificationsOpen = true;
    const out = await html(createElement(QuickActions));
    expect(centre.mounts).toBe(1);
    expect(out.match(/data-centre-stub/g)).toHaveLength(1);
    expect(out).toContain('aria-expanded="true"');
    // The centre is a sibling of the bell inside the one `relative` wrapper
    // the popover hangs from.
    const wrapper = out.indexOf('<div class="relative"><button');
    expect(wrapper).toBeGreaterThan(-1);
    expect(out.indexOf("data-notifications-trigger")).toBeGreaterThan(wrapper);
    expect(out.indexOf("data-centre-stub")).toBeGreaterThan(
      out.indexOf("data-notifications-trigger"),
    );
  });

  it("would mount one centre PER group: the guard against a second group is the route matrix in chrome.render.test.ts", async () => {
    store.notificationsOpen = true;
    await html(
      createElement(
        "div",
        null,
        createElement(QuickActions),
        createElement(QuickActions),
      ),
    );
    expect(centre.mounts).toBe(2);
  });
});
