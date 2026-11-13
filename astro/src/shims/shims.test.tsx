import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Link from "./next-link";
import { PhoneMenu } from "./PhoneMenu";
import { useAppStore } from "./store";

describe("next/link shim", () => {
  it("is a plain anchor with the href, for a page this app serves", () => {
    const html = renderToStaticMarkup(
      createElement(
        Link,
        { href: "/about", prefetch: false, className: "x" },
        "About",
      ),
    );
    expect(html).toBe('<a href="/about" class="x">About</a>');
  });

  it("forces a full page load for a page the Next.js app owns", () => {
    const html = renderToStaticMarkup(
      createElement(Link, { href: "/explore" }, "Explore"),
    );
    expect(html).toContain('data-astro-reload=""');
  });

  it("does not pass Next-only props to the DOM", () => {
    const html = renderToStaticMarkup(
      createElement(
        Link,
        { href: "/about", prefetch: true, replace: true, scroll: false },
        "x",
      ),
    );
    expect(html).not.toMatch(/prefetch|replace|scroll/);
  });
});

describe("account control shim", () => {
  it("is a link to /profile that the Next.js app answers, with a name", () => {
    const html = renderToStaticMarkup(
      createElement(PhoneMenu, { buttonClassName: "round" }),
    );
    expect(html).toContain('href="/profile"');
    expect(html).toContain('aria-label="Account"');
    expect(html).toContain('data-astro-reload=""');
    expect(html).toContain('class="round"');
  });
});

describe("store shim", () => {
  it("answers with the first-visit defaults the lane needs", () => {
    expect(useAppStore((s) => s.savedLocations)).toEqual([]);
    expect(useAppStore((s) => s.selectedLocation)).toBe("");
    expect(useAppStore((s) => s.presetAnchor)).toBeNull();
    expect(useAppStore((s) => s.hiddenPresetSlugs)).toEqual([]);
  });
});
