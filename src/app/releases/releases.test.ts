/**
 * /releases page, its Atom feed, and the places that must know about the
 * route (proxy + loading-scene KNOWN_ROUTES, current-slug, sitemap, footer,
 * profile navigation, about page).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReleaseEntry } from "@/components/releases/ReleaseEntry";
import { loadReleaseNotes } from "@/lib/release-notes-source";
import { releaseDate } from "@/lib/release-notes";
import { NON_LOCATION_ROUTES } from "@/lib/current-slug";
import { PROFILE_DESTINATIONS } from "@/components/profile/ProfileNavigation";
import sitemap from "../sitemap";
import { GET } from "./feed.xml/route";

const read = (p: string) => readFileSync(resolve(__dirname, p), "utf-8");
const page = read("page.tsx");
const entry = read("../../components/releases/ReleaseEntry.tsx");
const FIXTURES = resolve(__dirname, "../../lib/__fixtures__/release-notes");

describe("/releases — server page", () => {
  it("is static, built from the curated files, with no runtime fetch", () => {
    expect(page).toContain('export const dynamic = "force-static"');
    expect(page).toContain("loadReleaseNotes()");
    expect(page).not.toContain('"use client"');
    expect(page).not.toMatch(/fetch\(/);
  });

  it("sets its own canonical and the Atom alternate link", () => {
    expect(page).toContain("canonical: `${SITE_URL}/releases`");
    expect(page).toContain('"application/atom+xml"');
    expect(page).toContain("`${SITE_URL}/releases/feed.xml`");
  });

  it("is indexable (no robots noindex)", () => {
    expect(page).not.toMatch(/index:\s*false/);
  });

  it("emits JSON-LD through the shared JsonLd component", () => {
    expect(page).toContain("releasesJsonLd(releases, SITE_URL)");
    expect(page).toContain('<JsonLd key={schema["@type"]} data={schema} />');
    expect(read("../../components/layout/JsonLd.tsx")).toContain("safeJsonLd");
  });

  it("has the main landmark, one h1, a visible breadcrumb and a labelled list", () => {
    expect(page).toContain("<PageShell");
    expect(page).toContain("<PageHeader");
    expect(page).toContain('title="Release notes"');
    expect(page).toContain('trail({ label: "Release notes" })');
    expect(page).toContain('aria-label="Releases"');
  });

  it("links the full technical history on GitHub, clearly labelled", () => {
    expect(page).toContain("GITHUB_RELEASES_URL");
    expect(page).toContain("Full technical history on GitHub");
  });
});

describe("ReleaseEntry — rendered structure", () => {
  const [release] = loadReleaseNotes(FIXTURES);
  const html = renderToStaticMarkup(
    createElement(ReleaseEntry, { release, latest: true }),
  );

  it("is an article labelled by its h2, anchored by version", () => {
    expect(html).toMatch(
      /^<article id="v1-10-0" aria-labelledby="v1-10-0-title"/,
    );
    expect(html).toContain('<h2 id="v1-10-0-title"');
  });

  it("puts the ISO date in a <time> element", () => {
    expect(html).toContain('<time dateTime="2025-04-02">2 April 2025</time>');
  });

  it("renders each non-empty section as a labelled section with an h3", () => {
    for (const id of ["new", "improved", "security"]) {
      expect(html).toContain(`aria-labelledby="v1-10-0-${id}"`);
      expect(html).toContain(`<h3 id="v1-10-0-${id}"`);
    }
    expect(html).not.toContain("Known issues");
    expect(html).not.toContain("Fixed");
  });

  it("hides decorative bullets and renders bold lead phrases", () => {
    expect(html).toMatch(/<span aria-hidden="true" class="[^"]*rounded-full/);
    expect(html).toContain(">Lead.</strong>");
  });

  it("escapes item text", () => {
    expect(html).toContain("Safer &amp; &lt;sounder&gt; sign-in.");
  });

  it("marks the latest release and links its GitHub release", () => {
    expect(html).toContain(">Latest</span>");
    expect(html).toContain(
      'href="https://github.com/mukoko-dev/mukoko-weather/releases/tag/v1.10.0"',
    );
  });

  it("omits the badge and the GitHub link when they do not apply", () => {
    const older = loadReleaseNotes(FIXTURES)[1];
    const out = renderToStaticMarkup(
      createElement(ReleaseEntry, { release: older }),
    );
    expect(out).not.toContain("Latest");
    expect(out).not.toContain("on GitHub");
  });

  it("uses global tokens and fauna classes only — no inline styles or hex", () => {
    expect(entry).not.toMatch(/style=\{\{/);
    expect(entry).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(entry).not.toMatch(/rgba?\(/);
    expect(entry).toContain("baobab");
  });
});

describe("/releases/feed.xml", () => {
  it("serves the Atom feed of the shipped notes", async () => {
    const res = GET();
    expect(res.headers.get("content-type")).toBe(
      "application/atom+xml; charset=utf-8",
    );
    const xml = await res.text();
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain("https://weather.mukoko.com/releases#v0-11-0");
    expect(xml).toContain("https://weather.mukoko.com/releases#v0-10-0");
  });

  it("is built at build time", () => {
    expect(read("feed.xml/route.ts")).toContain(
      'export const dynamic = "force-static"',
    );
  });
});

describe("/releases — route registration", () => {
  it("is a known, non-location route everywhere", () => {
    expect(read("../../proxy.ts")).toMatch(
      /KNOWN_ROUTES = new Set\(\[[^\]]*"releases"/,
    );
    expect(read("../../components/weather/WeatherLoadingScene.tsx")).toMatch(
      /KNOWN_ROUTES = new Set\(\[[^\]]*"releases"/,
    );
    expect(NON_LOCATION_ROUTES.has("releases")).toBe(true);
  });

  it("is in the sitemap", async () => {
    const entries = await sitemap();
    const hit = entries.find(
      (e) => e.url === "https://weather.mukoko.com/releases",
    );
    expect(hit).toBeDefined();
    expect(hit!.changeFrequency).toBe("weekly");
    // lastModified is the newest release's date, not the request time.
    const [newest] = loadReleaseNotes();
    expect(hit!.lastModified).toEqual(releaseDate(newest.date));
  });

  it("traces releases/ into the dynamic sitemap function", () => {
    expect(read("../../../next.config.ts")).toMatch(
      /outputFileTracingIncludes:\s*\{\s*"\/sitemap\.xml":\s*\["\.\/releases\/\*\.md"\]/,
    );
  });

  it("is linked from the footer, the about page and profile navigation", () => {
    // The footer reads its links from lib/nav-destinations (one list for every surface).
    expect(read("../../components/layout/Footer.tsx")).toContain(
      'navLink("releases")',
    );
    expect(
      PROFILE_DESTINATIONS.find((d) => d.href === "/releases")?.label,
    ).toBe("Release notes");
    expect(read("../about/page.tsx")).toContain('href="/releases"');
    expect(PROFILE_DESTINATIONS.some((d) => d.href === "/releases")).toBe(true);
  });
});

describe("/releases — page tier files and markup details", () => {
  it("has a loading skeleton with a status role", () => {
    const loading = read("loading.tsx");
    expect(loading).toContain("<PageShellSkeleton");
    expect(loading).toContain("breadcrumb");
  });

  it("has an error boundary built on RouteErrorBoundary", () => {
    const error = read("error.tsx");
    expect(error).toContain('"use client"');
    expect(error).toContain("<RouteErrorBoundary");
    expect(error).toContain('source="releases"');
  });

  it("keys list items by position, never by their text", () => {
    expect(entry).not.toMatch(/key=\{(item|p)\}/);
  });

  it("gives every inline link a full touch target (.dik-dik)", () => {
    for (const src of [page, entry]) {
      for (const m of src.matchAll(/className="sunbird[^"]*"/g)) {
        expect(m[0]).toContain("dik-dik");
      }
    }
  });
});
