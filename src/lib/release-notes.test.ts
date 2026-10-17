/**
 * Public release notes — parser, ordering, grouping, outputs, and the real
 * files in releases/. No test here reads the clock: every date comes from a
 * fixture or a release file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  GITHUB_RELEASES_URL,
  RELEASE_SECTIONS,
  ReleaseNoteError,
  buildReleasesAtomFeed,
  escapeXml,
  formatReleaseDate,
  githubReleaseUrl,
  isIsoDate,
  parseInline,
  parseReleaseNote,
  plainText,
  releaseAnchor,
  releaseToHtml,
  releasesJsonLd,
  sortReleases,
  type ReleaseNote,
} from "./release-notes";
import { RELEASES_DIR, loadReleaseNotes } from "./release-notes-source";

const FIXTURES = resolve(__dirname, "__fixtures__/release-notes");
const SITE = "https://weather.mukoko.com";

function note(
  body: string,
  front = "version: 2.0.0\ndate: 2026-01-05\ntitle: T",
) {
  return `---\n${front}\n---\n\n${body}`;
}
const parse = (src: string, file = "v2.0.0.md") => parseReleaseNote(src, file);

describe("parseReleaseNote — front matter", () => {
  it("reads version, date, title and an optional GitHub link", () => {
    const r = parse(
      note(
        "## New\n\n- x",
        `version: 2.0.0\ndate: 2026-01-05\ntitle: Hello\ngithub: ${githubReleaseUrl("2.0.0")}`,
      ),
    );
    expect(r).toMatchObject({
      version: "2.0.0",
      date: "2026-01-05",
      title: "Hello",
      githubUrl: `${GITHUB_RELEASES_URL}/tag/v2.0.0`,
    });
  });

  it("leaves githubUrl unset when the release is not on GitHub yet", () => {
    expect(parse(note("## New\n\n- x")).githubUrl).toBeUndefined();
  });

  it.each([
    ["no front matter", "## New\n\n- x", /front-matter block/],
    ["unclosed front matter", "---\nversion: 2.0.0\n## New", /not closed/],
  ])("rejects %s", (_, src, msg) => {
    expect(() => parse(src)).toThrow(msg);
  });

  it.each([
    [
      "a v-prefixed version",
      "version: v2.0.0\ndate: 2026-01-05\ntitle: T",
      /X\.Y\.Z/,
    ],
    [
      "a non-semver version",
      "version: 2.0\ndate: 2026-01-05\ntitle: T",
      /X\.Y\.Z/,
    ],
    [
      "an impossible date",
      "version: 2.0.0\ndate: 2026-02-30\ntitle: T",
      /YYYY-MM-DD/,
    ],
    [
      "a non-ISO date",
      "version: 2.0.0\ndate: 05/01/2026\ntitle: T",
      /YYYY-MM-DD/,
    ],
    [
      "a missing title",
      "version: 2.0.0\ndate: 2026-01-05",
      /title is required/,
    ],
    [
      "an unknown key",
      "version: 2.0.0\ndate: 2026-01-05\ntitle: T\nauthor: x",
      /unknown front-matter key/,
    ],
    [
      "a repeated key",
      "version: 2.0.0\ndate: 2026-01-05\ntitle: T\ntitle: U",
      /duplicate/,
    ],
    [
      "a foreign GitHub link",
      "version: 2.0.0\ndate: 2026-01-05\ntitle: T\ngithub: https://example.com/x",
      /github must be/,
    ],
    [
      "a link to another tag",
      `version: 2.0.0\ndate: 2026-01-05\ntitle: T\ngithub: ${githubReleaseUrl("1.0.0")}`,
      /github must be/,
    ],
  ])("rejects %s", (_, front, msg) => {
    expect(() => parse(note("## New\n\n- x", front))).toThrow(msg);
  });

  it("requires the file name to match the version", () => {
    expect(() => parse(note("## New\n\n- x"), "v2.0.1.md")).toThrow(
      /must be named v2\.0\.0\.md/,
    );
  });

  it("names the file in every error", () => {
    expect(() => parse("nope", "v9.9.9.md")).toThrow(ReleaseNoteError);
    expect(() => parse("nope", "v9.9.9.md")).toThrow(/^v9\.9\.9\.md: /);
  });

  it("accepts Windows line endings", () => {
    const r = parse(note("## New\n\n- x").replace(/\n/g, "\r\n"));
    expect(r.sections[0].items).toEqual(["x"]);
  });
});

describe("parseReleaseNote — sections", () => {
  it("groups items in the fixed display order, whatever the file order", () => {
    const r = parse(
      note("## Fixed\n\n- f\n\n## New\n\n- n\n\n## Security\n\n- s"),
    );
    expect(r.sections.map((s) => s.id)).toEqual(["new", "fixed", "security"]);
  });

  it("drops a section with no items (empty template headings)", () => {
    const r = parse(note("## New\n\n- n\n\n## Known issues\n\n## Fixed\n"));
    expect(r.sections.map((s) => s.id)).toEqual(["new"]);
  });

  it("joins indented continuation lines onto their bullet", () => {
    const r = parse(note("## New\n\n- first part\n  second part\n- next"));
    expect(r.sections[0].items).toEqual(["first part second part", "next"]);
  });

  it("collects paragraphs before the first section as the summary", () => {
    const r = parse(note("One line\nwrapped.\n\nTwo.\n\n## New\n\n- n"));
    expect(r.summary).toEqual(["One line wrapped.", "Two."]);
  });

  it.each([
    ["an unknown heading", "## Changes\n\n- x", /unknown section "Changes"/],
    ["a repeated heading", "## New\n\n- a\n\n## New\n\n- b", /appears twice/],
    [
      "a deeper heading",
      "## New\n\n### Sub\n\n- x",
      /only ## section headings/,
    ],
    [
      "a top-level heading",
      "# Title\n\n## New\n\n- x",
      /only ## section headings/,
    ],
    [
      "a bullet outside a section",
      "- stray\n\n## New\n\n- x",
      /must sit under a ## section/,
    ],
    [
      "prose under a section",
      "## New\n\nJust a sentence.",
      /must be a "- " list item/,
    ],
    [
      "a release with no items at all",
      "## New\n\n## Fixed\n",
      /at least one list item/,
    ],
  ])("rejects %s", (_, body, msg) => {
    expect(() => parse(note(body))).toThrow(msg);
  });

  it("lists exactly the five public sections", () => {
    expect(RELEASE_SECTIONS.map((s) => s.heading)).toEqual([
      "New",
      "Improved",
      "Fixed",
      "Security",
      "Known issues",
    ]);
  });
});

describe("loadReleaseNotes — fixtures", () => {
  const releases = loadReleaseNotes(FIXTURES);

  it("reads only vX.Y.Z.md files", () => {
    expect(releases.map((r) => r.version)).toEqual(["1.10.0", "1.2.0"]);
  });

  it("orders by semver, not by text (1.10.0 above 1.2.0)", () => {
    expect(releases[0].version).toBe("1.10.0");
  });

  it("parses the full fixture", () => {
    const r = releases[0];
    expect(r.summary).toEqual(["A summary paragraph that spans two lines."]);
    expect(r.sections.map((s) => s.heading)).toEqual([
      "New",
      "Improved",
      "Security",
    ]);
    expect(r.sections[0].items).toEqual([
      "**Lead.** First new thing.",
      "Second new thing that wraps onto a second line.",
    ]);
    expect(r.githubUrl).toBe(githubReleaseUrl("1.10.0"));
  });
});

describe("sortReleases", () => {
  const mk = (version: string, date: string): ReleaseNote => ({
    version,
    date,
    title: version,
    summary: [],
    sections: [{ id: "new", heading: "New", items: ["x"] }],
  });

  it("puts the highest version first", () => {
    const sorted = sortReleases([
      mk("0.9.0", "2026-10-11"),
      mk("0.11.0", "2026-10-17"),
      mk("0.10.0", "2026-10-11"),
    ]);
    expect(sorted.map((r) => r.version)).toEqual(["0.11.0", "0.10.0", "0.9.0"]);
  });

  it("does not mutate its input", () => {
    const input = [mk("1.0.0", "2026-01-01"), mk("2.0.0", "2026-02-01")];
    sortReleases(input);
    expect(input[0].version).toBe("1.0.0");
  });

  it("refuses a version listed twice", () => {
    expect(() =>
      sortReleases([mk("1.0.0", "2026-01-01"), mk("1.0.0", "2026-01-02")]),
    ).toThrow(/listed twice/);
  });
});

describe("inline text and formatting helpers", () => {
  it("splits **bold** runs and keeps unpaired markers literal", () => {
    expect(parseInline("**A.** b **c** d")).toEqual([
      { text: "A.", strong: true },
      { text: " b ", strong: false },
      { text: "c", strong: true },
      { text: " d", strong: false },
    ]);
    expect(parseInline("2 ** 3")).toEqual([{ text: "2 ** 3", strong: false }]);
    expect(plainText("**A.** b")).toBe("A. b");
  });

  it("validates ISO calendar dates", () => {
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2025-02-29")).toBe(false);
    expect(isIsoDate("2025-13-01")).toBe(false);
    expect(isIsoDate("2025-1-01")).toBe(false);
  });

  it("formats the calendar day in UTC, so it never shifts a day", () => {
    expect(formatReleaseDate("2026-10-17")).toBe("17 October 2026");
    expect(formatReleaseDate("2026-01-01")).toBe("1 January 2026");
  });

  it("builds stable anchors", () => {
    expect(releaseAnchor("0.11.0")).toBe("v0-11-0");
  });

  it("escapes XML", () => {
    expect(escapeXml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;",
    );
  });

  it("renders a release as escaped HTML", () => {
    const [r] = loadReleaseNotes(FIXTURES);
    const html = releaseToHtml(r);
    expect(html).toContain("<h2>New</h2>");
    expect(html).toContain("<li><strong>Lead.</strong> First new thing.</li>");
    expect(html).toContain("Safer &amp; &lt;sounder&gt; sign-in.");
    expect(html).not.toContain("<sounder>");
  });
});

describe("buildReleasesAtomFeed", () => {
  const releases = loadReleaseNotes(FIXTURES);
  const xml = buildReleasesAtomFeed(releases, SITE);

  it("is an Atom 1.0 document with self and alternate links", () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n')).toBe(
      true,
    );
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain(
      `<link rel="self" type="application/atom+xml" href="${SITE}/releases/feed.xml"/>`,
    );
    expect(xml).toContain(
      `<link rel="alternate" type="text/html" href="${SITE}/releases"/>`,
    );
    expect(xml.trimEnd().endsWith("</feed>")).toBe(true);
  });

  it("takes updated from the newest release, never the clock", () => {
    expect(xml).toContain("<updated>2025-04-02T00:00:00Z</updated>");
    expect(buildReleasesAtomFeed(releases, SITE)).toBe(xml);
  });

  it("has one entry per release with RFC 3339 dates, newest first", () => {
    const entries = xml.split("<entry>").slice(1);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toContain(`<id>${SITE}/releases#v1-10-0</id>`);
    expect(entries[0]).toContain("<published>2025-04-02T00:00:00Z</published>");
    expect(entries[1]).toContain(`<id>${SITE}/releases#v1-2-0</id>`);
    // Only the release with a summary carries <summary>.
    expect(entries[0]).toContain("<summary>");
    expect(entries[1]).not.toContain("<summary>");
  });

  it("keeps every element balanced and every raw < > & escaped in text", () => {
    for (const tag of ["feed", "entry", "title", "id", "updated", "content"]) {
      const open = xml.match(new RegExp(`<${tag}[ >]`, "g"))?.length ?? 0;
      const close = xml.match(new RegExp(`</${tag}>`, "g"))?.length ?? 0;
      expect(close, tag).toBe(open);
    }
    const content = xml.match(
      /<content type="html">([\s\S]*?)<\/content>/,
    )?.[1];
    expect(content).toBeDefined();
    expect(content).not.toMatch(/[<>]/);
    expect(content).toContain("&amp;lt;sounder&amp;gt;");
  });

  it("still produces a valid feed with no releases", () => {
    const empty = buildReleasesAtomFeed([], SITE);
    expect(empty).toContain("<updated>1970-01-01T00:00:00Z</updated>");
    expect(empty).not.toContain("<entry>");
  });
});

describe("releasesJsonLd", () => {
  const releases = loadReleaseNotes(FIXTURES);
  const [page, crumbs] = releasesJsonLd(releases, SITE);

  it("is a CollectionPage whose mainEntity lists SoftwareApplication versions", () => {
    expect(page["@type"]).toBe("CollectionPage");
    expect(page.url).toBe(`${SITE}/releases`);
    expect(page.dateModified).toBe("2025-04-02");
    expect(page.mainEntity["@type"]).toBe("ItemList");
    expect(page.mainEntity.numberOfItems).toBe(2);
    const first = page.mainEntity.itemListElement[0];
    expect(first.position).toBe(1);
    expect(first.item).toMatchObject({
      "@type": "SoftwareApplication",
      softwareVersion: "1.10.0",
      datePublished: "2025-04-02",
      releaseNotes: `${SITE}/releases#v1-10-0`,
      sameAs: githubReleaseUrl("1.10.0"),
    });
    expect(page.mainEntity.itemListElement[1].item.sameAs).toBeUndefined();
  });

  it("carries a Home → Release notes BreadcrumbList", () => {
    expect(crumbs["@type"]).toBe("BreadcrumbList");
    expect(crumbs.itemListElement.map((i: { name: string }) => i.name)).toEqual(
      ["Home", "Release notes"],
    );
  });
});

describe("releases/ — the shipped notes", () => {
  const releases = loadReleaseNotes();

  it("loads from the repo-root releases/ folder", () => {
    expect(RELEASES_DIR.endsWith("releases")).toBe(true);
    expect(releases.length).toBeGreaterThanOrEqual(2);
  });

  it("starts the public history at v0.10.0 and includes v0.11.0", () => {
    const versions = releases.map((r) => r.version);
    expect(versions).toContain("0.10.0");
    expect(versions).toContain("0.11.0");
    expect(versions[0]).toBe("0.11.0");
  });

  it("links v0.10.0 to its published GitHub release", () => {
    const v010 = releases.find((r) => r.version === "0.10.0");
    expect(v010?.githubUrl).toBe(githubReleaseUrl("0.10.0"));
  });

  it("keeps internal references and jargon out of the public text", () => {
    for (const r of releases) {
      const text = [
        r.title,
        ...r.summary,
        ...r.sections.flatMap((s) => s.items),
      ].join("\n");
      // No PR/issue numbers, file paths, code or env names in user-facing prose.
      expect(text, r.version).not.toMatch(/#\d+/);
      expect(text, r.version).not.toMatch(/`/);
      expect(text, r.version).not.toMatch(/\b(src|api)\/|\.tsx?\b|\.py\b/);
      expect(text, r.version).not.toMatch(/\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/);
      // No model or vendor-internal names.
      expect(text, r.version).not.toMatch(
        /\b(GLM|Claude|GPT|Gemini|Llama|Workers AI)\b/i,
      );
    }
  });

  it("is never fetched from GitHub at runtime", () => {
    for (const file of [
      "release-notes.ts",
      "release-notes-source.ts",
      "../app/releases/page.tsx",
      "../app/releases/feed.xml/route.ts",
    ]) {
      const src = readFileSync(resolve(__dirname, file), "utf-8");
      expect(src, file).not.toMatch(/fetch\(|api\.github\.com/);
    }
  });
});
