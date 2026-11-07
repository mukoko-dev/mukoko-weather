/**
 * MyLocationLink — the round arrow link to `/` that took the account avatar's
 * old places (owner, 2026-11-05): the hero's top-right group beside Share, and
 * the header's pill on the pages that have no hero. It renders for real
 * (react-dom/server); its click handler is read off the element it returns,
 * with the real place bus behind it.
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const nav = vi.hoisted(() => ({
  pathname: "/harare",
  push: vi.fn<(href: string) => void>(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: nav.push }),
}));

import { MyLocationLink } from "./MyLocationLink";
import { registerPlaceStage } from "@/lib/place-bus";

const source = readFileSync(resolve(__dirname, "MyLocationLink.tsx"), "utf-8");

function render(
  props: { className: string; iconClassName?: string } = {
    className: "duiker",
  },
) {
  return renderToStaticMarkup(createElement(MyLocationLink, props));
}

/** The click handler the link hands to `next/link`. */
function onClick(): (event: unknown) => void {
  const element = MyLocationLink({ className: "duiker" }) as ReactElement<{
    onClick: (event: unknown) => void;
  }>;
  return element.props.onClick;
}

function click(overrides: Record<string, unknown> = {}) {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  nav.pathname = "/harare";
  nav.push.mockClear();
});

describe("MyLocationLink — what it renders", () => {
  it("is a real link to `/` named My Location, with a decorative 20px arrow", () => {
    const html = render();
    expect(html).toMatch(/^<a\b/);
    expect(html).toContain('href="/"');
    expect(html).toContain('aria-label="My Location"');
    expect(html).toContain('title="My Location"');
    expect(html).toContain('width="20" height="20"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("<polygon");
  });

  it("takes its control class from the caller: duiker in the hero's group, bee in the header's pill", () => {
    expect(render({ className: "duiker" })).toContain('class="duiker"');
    const pill = render({
      className: "bee sm:hidden",
      iconClassName: "text-primary-foreground",
    });
    expect(pill).toContain('class="bee sm:hidden"');
    expect(pill).toContain('class="text-primary-foreground"');
  });

  it("is not the current page anywhere but `/`", () => {
    for (const pathname of ["/harare", "/locations", "/explore", "/x/map"]) {
      nav.pathname = pathname;
      expect(render(), pathname).not.toContain("aria-current");
    }
  });

  it("is the current page on `/`, with the arrow filled", () => {
    nav.pathname = "/";
    const html = render();
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("fill-current");
  });

  it("styles come from the caller's class: no inline style, hex or rgba", () => {
    expect(source).not.toMatch(/style=\{\{/);
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toContain("rgba(");
  });
});

describe("MyLocationLink — a click", () => {
  let unregister = () => {};
  afterEach(() => unregister());

  it("with no place stage mounted, a plain click navigates with the router", () => {
    const event = click();
    onClick()(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(nav.push).toHaveBeenCalledExactlyOnceWith("/");
  });

  it("with a stage that can show My Location, a plain click switches in place and does not navigate", async () => {
    const show = vi.fn().mockResolvedValue(true);
    unregister = registerPlaceStage({
      canShow: (target) => target.kind === "home",
      show,
    });
    const event = click();
    onClick()(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledExactlyOnceWith({ kind: "home" });
    await Promise.resolve();
    await Promise.resolve();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("falls back to the router when the stage cannot show it, or fails", async () => {
    unregister = registerPlaceStage({
      canShow: () => false,
      show: vi.fn(),
    });
    onClick()(click());
    expect(nav.push).toHaveBeenCalledExactlyOnceWith("/");

    nav.push.mockClear();
    unregister();
    unregister = registerPlaceStage({
      canShow: () => true,
      show: vi.fn().mockResolvedValue(false),
    });
    onClick()(click());
    await Promise.resolve();
    await Promise.resolve();
    expect(nav.push).toHaveBeenCalledExactlyOnceWith("/");
  });

  it("leaves a modified or non-primary click to the browser (a new tab, a download)", () => {
    for (const overrides of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
      { defaultPrevented: true },
    ]) {
      const event = click(overrides);
      onClick()(event);
      expect(
        event.preventDefault,
        JSON.stringify(overrides),
      ).not.toHaveBeenCalled();
    }
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("sends no location_changed event: `/` is not a saved slug", () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain("trackEvent");
    expect(code).not.toContain("trackPlaceChange");
  });
});
