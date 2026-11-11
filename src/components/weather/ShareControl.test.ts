/**
 * ShareControl: Share, the first control of the Quick actions group, rendered
 * for real (react-dom/server) plus source checks for what a render cannot show
 * (the click handler, the timers). One control on every page: it shares the
 * place when a place is on screen and the page everywhere else.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SHARE_PAGE_LABEL,
  ShareControl,
  buildShareData,
  pageAddress,
  shareLabel,
} from "./ShareControl";

const source = readFileSync(resolve(__dirname, "ShareControl.tsx"), "utf-8");

const render = (place?: { name: string; slug?: string } | null) =>
  renderToStaticMarkup(createElement(ShareControl, { place }));

describe("ShareControl: one control for every page", () => {
  it("is a round .bee button, with no variant split left", () => {
    expect(render({ name: "Harare", slug: "harare" })).toMatch(
      /<button[^>]*class="bee"/,
    );
    expect(render()).toMatch(/<button[^>]*class="bee"/);
    expect(source).not.toContain("variant");
    expect(source).not.toContain("kestrel-round");
    expect(source).not.toContain("duiker");
  });

  it("is icon-only: its name is the aria-label, the glyph is hidden from assistive tech", () => {
    for (const place of [{ name: "Harare", slug: "harare" }, null]) {
      const html = render(place);
      expect(html).toMatch(/aria-label="Share [^"]*"/);
      expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    }
  });

  it('is named "Share weather for {name}" on a place page and "Share this page" on any other', () => {
    expect(render({ name: "Harare", slug: "harare" })).toContain(
      'aria-label="Share weather for Harare"',
    );
    expect(render({ name: "Phuket Island" })).toContain(
      'aria-label="Share weather for Phuket Island"',
    );
    expect(render()).toContain('aria-label="Share this page"');
    expect(render(null)).toContain('aria-label="Share this page"');
    expect(shareLabel(null)).toBe(SHARE_PAGE_LABEL);
    expect(SHARE_PAGE_LABEL).toBe("Share this page");
    // The tooltip says the same as the name.
    expect(render()).toContain('title="Share this page"');
  });

  it("holds an empty polite status region until there is something to say", () => {
    for (const place of [{ name: "Harare", slug: "harare" }, null]) {
      expect(render(place)).toMatch(
        /<span role="status" class="sr-only"><\/span>/,
      );
    }
  });

  it("shows its note on a card surface: readable over the sky and over the cards that scroll under the group", () => {
    const note = source.match(/"(serval [^"]*)"/)?.[1] ?? "";
    expect(note).toContain("text-text-primary");
    expect(note).toContain("absolute top-full right-0");
    expect(note).not.toContain("sky-fg");
  });
});

describe("ShareControl: what is shared", () => {
  const page = {
    href: "https://weather.mukoko.com/releases",
    title: "Releases",
  };

  it("shares a place's own address, title and sentence", () => {
    expect(buildShareData({ name: "Harare", slug: "harare" }, page)).toEqual({
      title: "Harare Weather",
      text: "Check the weather in Harare on mukoko weather",
      url: "https://weather.mukoko.com/harare",
    });
  });

  it("shares the address in the bar for a place with no slug (the label still names the place)", () => {
    const place = { name: "Harare" };
    expect(buildShareData(place, page).url).toBe(page.href);
    expect(buildShareData(place, page).title).toBe("Harare Weather");
    expect(shareLabel(place)).toBe("Share weather for Harare");
  });

  it("on a page that is not a place, shares the page's address and its title", () => {
    expect(buildShareData(null, page)).toEqual({
      title: "Releases",
      url: "https://weather.mukoko.com/releases",
    });
    expect(buildShareData(undefined, page)).toEqual({
      title: "Releases",
      url: "https://weather.mukoko.com/releases",
    });
  });

  it("never shares a query string or a fragment: a link carries no state", () => {
    expect(
      buildShareData(null, {
        href: "https://weather.mukoko.com/explore?q=harare&token=abc#top",
        title: "Explore",
      }).url,
    ).toBe("https://weather.mukoko.com/explore");
    // A place with no slug shares the page's address, cleaned the same way.
    expect(
      buildShareData(
        { name: "Harare" },
        { href: "https://weather.mukoko.com/?utm=x#a", title: "Harare" },
      ).url,
    ).toBe("https://weather.mukoko.com/");
    // Origin and path stay (a preview or a local build shares itself).
    expect(pageAddress("http://localhost:3100/releases?x=1")).toBe(
      "http://localhost:3100/releases",
    );
    expect(pageAddress("https://weather.mukoko.com/harare/forecast#h")).toBe(
      "https://weather.mukoko.com/harare/forecast",
    );
    // What will not parse is left as it was.
    expect(pageAddress("not a url?x")).toBe("not a url?x");
  });

  it("falls back to the site's name when the page has no title", () => {
    expect(
      buildShareData(null, { href: "https://weather.mukoko.com/", title: "" }),
    ).toEqual({ title: "mukoko weather", url: "https://weather.mukoko.com/" });
  });

  it("reads the address and the title when the person taps, not when it renders", () => {
    expect(source).toContain("window.location.href");
    expect(source).toContain("document.title");
    expect(source).toContain("buildShareData(place, {");
  });
});

describe("ShareControl: behaviour", () => {
  it("uses the Web Share API when there is one", () => {
    expect(source).toContain("navigator.share");
    expect(source).toContain("share(shareData)");
  });

  it("falls back to copying the link, and says so (and says when that failed)", () => {
    expect(source).toMatch(
      /navigator\.clipboard\s*\.writeText\(shareData\.url\)/,
    );
    expect(source).toContain("Link copied");
    expect(source).toContain("Copy failed");
    expect(source).toContain("setCopied(true)");
    expect(source).toContain("setCopyFailed(true)");
    // No clipboard (an insecure origin) is a failure to say, not a throw.
    expect(source).toContain("!navigator.clipboard");
  });

  it("clears each note after 2 seconds, and its timer on unmount", () => {
    expect(
      source.match(
        /setTimeout\(\(\) => set(Copied|CopyFailed)\(false\), 2000\)/g,
      ),
    ).toHaveLength(2);
    expect(source.match(/return \(\) => clearTimeout\(t\)/g)).toHaveLength(2);
  });

  it("links a place to https://weather.mukoko.com/{slug}", () => {
    expect(source).toContain('const BASE_URL = "https://weather.mukoko.com"');
    expect(source).toContain("`${BASE_URL}/${place.slug}`");
  });
});
