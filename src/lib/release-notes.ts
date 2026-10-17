/**
 * Public release notes — the parser, ordering and output builders behind
 * `/releases` and `/releases/feed.xml`.
 *
 * Source of truth: one curated Markdown file per production release in
 * `releases/` at the repo root (`releases/v0.11.0.md`), written for the
 * people who use the app. `RELEASES.md` stays the technical, operator-facing
 * history; the auto-generated GitHub pre-releases are never rendered.
 *
 * File format (strict — a malformed file fails the build, never the page):
 *
 * ```md
 * ---
 * version: 0.11.0
 * date: 2026-10-17
 * title: Faster on phones, and weather for anywhere
 * github: https://github.com/mukoko-dev/mukoko-weather/releases/tag/v0.11.0
 * ---
 *
 * Optional summary paragraph.
 *
 * ## New
 *
 * - **Lead phrase.** Plain-language sentence.
 * ```
 *
 * - `version` is semver without the `v`; the file name must be `v{version}.md`.
 * - `date` is an ISO 8601 calendar date (YYYY-MM-DD), the day it reached
 *   production.
 * - `github` is optional and must be this repo's release URL for this tag.
 * - Section headings are limited to {@link RELEASE_SECTIONS}, each at most
 *   once. A heading with no bullets is dropped, so a template can keep empty
 *   headings.
 * - Items are single bullets (continuation lines are joined). The only inline
 *   markup is `**bold**`; anything else is shown as typed.
 *
 * Pure module: no `fs`, no clock. The loader lives in
 * `release-notes-source.ts`.
 */

/** This repo — every GitHub link on the page is built from it. */
export const REPO_URL = "https://github.com/mukoko-dev/mukoko-weather";

/** The full, technical GitHub release history (beta pre-releases included). */
export const GITHUB_RELEASES_URL = `${REPO_URL}/releases`;

/** Section ids in display order, with their public headings. */
export const RELEASE_SECTIONS = [
  { id: "new", heading: "New" },
  { id: "improved", heading: "Improved" },
  { id: "fixed", heading: "Fixed" },
  { id: "security", heading: "Security" },
  { id: "known-issues", heading: "Known issues" },
] as const;

export type ReleaseSectionId = (typeof RELEASE_SECTIONS)[number]["id"];

/** One inline run of an item: plain text, or `**bold**` text. */
export interface ReleaseTextRun {
  text: string;
  strong: boolean;
}

export interface ReleaseSection {
  id: ReleaseSectionId;
  heading: string;
  /** Raw item text, `**bold**` markers included. */
  items: string[];
}

export interface ReleaseNote {
  /** Semver without the leading `v`, e.g. `0.11.0`. */
  version: string;
  /** ISO 8601 calendar date, e.g. `2026-10-17`. */
  date: string;
  title: string;
  /** Paragraphs before the first section. */
  summary: string[];
  /** Non-empty sections only, in {@link RELEASE_SECTIONS} order. */
  sections: ReleaseSection[];
  /** GitHub release page for this tag, when one has been published. */
  githubUrl?: string;
}

export class ReleaseNoteError extends Error {
  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = "ReleaseNoteError";
  }
}

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FRONT_MATTER_KEYS = new Set(["version", "date", "title", "github"]);

/** True when `date` is a real calendar date in YYYY-MM-DD form. */
export function isIsoDate(date: string): boolean {
  const m = DATE_RE.exec(date);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d
  );
}

/** The GitHub release URL a `vX.Y.Z` tag would have. */
export function githubReleaseUrl(version: string): string {
  return `${GITHUB_RELEASES_URL}/tag/v${version}`;
}

/** Stable in-page anchor for a release: `v0-11-0`. */
export function releaseAnchor(version: string): string {
  return `v${version.replace(/\./g, "-")}`;
}

/**
 * Parse one release-notes file. `file` is the file name (`v0.11.0.md`),
 * used for the name check and in error messages.
 */
export function parseReleaseNote(source: string, file: string): ReleaseNote {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new ReleaseNoteError(
      file,
      "must start with a --- front-matter block",
    );
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    throw new ReleaseNoteError(file, "front matter is not closed with ---");
  }

  const meta: Record<string, string> = {};
  for (const raw of lines.slice(1, end)) {
    if (!raw.trim()) continue;
    const m = /^([a-z]+):\s*(.*)$/.exec(raw.trim());
    if (!m) throw new ReleaseNoteError(file, `bad front-matter line "${raw}"`);
    const [, key, value] = m;
    if (!FRONT_MATTER_KEYS.has(key)) {
      throw new ReleaseNoteError(file, `unknown front-matter key "${key}"`);
    }
    if (key in meta) {
      throw new ReleaseNoteError(file, `duplicate front-matter key "${key}"`);
    }
    meta[key] = value.trim();
  }

  const version = meta.version ?? "";
  if (!SEMVER_RE.test(version)) {
    throw new ReleaseNoteError(
      file,
      `version must be X.Y.Z without a "v", got "${version}"`,
    );
  }
  if (file !== `v${version}.md`) {
    throw new ReleaseNoteError(file, `file must be named v${version}.md`);
  }
  const date = meta.date ?? "";
  if (!isIsoDate(date)) {
    throw new ReleaseNoteError(file, `date must be YYYY-MM-DD, got "${date}"`);
  }
  const title = meta.title ?? "";
  if (!title) throw new ReleaseNoteError(file, "title is required");
  let githubUrl: string | undefined;
  if (meta.github) {
    if (meta.github !== githubReleaseUrl(version)) {
      throw new ReleaseNoteError(
        file,
        `github must be ${githubReleaseUrl(version)}, got "${meta.github}"`,
      );
    }
    githubUrl = meta.github;
  }

  const summary: string[] = [];
  const found = new Map<ReleaseSectionId, string[]>();
  let current: string[] | null = null;
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) summary.push(paragraph.join(" "));
    paragraph = [];
  };

  for (const raw of lines.slice(end + 1)) {
    const line = raw.trimEnd();
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      const name = heading[1].trim();
      const section = RELEASE_SECTIONS.find((s) => s.heading === name);
      if (!section) {
        throw new ReleaseNoteError(
          file,
          `unknown section "${name}" (allowed: ${RELEASE_SECTIONS.map((s) => s.heading).join(", ")})`,
        );
      }
      if (found.has(section.id)) {
        throw new ReleaseNoteError(file, `section "${name}" appears twice`);
      }
      current = [];
      found.set(section.id, current);
      continue;
    }
    if (line.startsWith("#")) {
      throw new ReleaseNoteError(
        file,
        `only ## section headings are allowed: "${line}"`,
      );
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      if (!current) {
        throw new ReleaseNoteError(
          file,
          "list items must sit under a ## section",
        );
      }
      current.push(bullet[1].trim());
      continue;
    }
    if (!line.trim()) {
      if (!current) flushParagraph();
      continue;
    }
    if (current) {
      // An indented continuation of the previous bullet.
      if (!current.length || !/^\s+/.test(raw)) {
        throw new ReleaseNoteError(
          file,
          `text under a section must be a "- " list item: "${line.trim()}"`,
        );
      }
      current[current.length - 1] += ` ${line.trim()}`;
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();

  const sections: ReleaseSection[] = RELEASE_SECTIONS.flatMap((s) => {
    const items = found.get(s.id);
    return items && items.length
      ? [{ id: s.id, heading: s.heading, items }]
      : [];
  });
  if (!sections.length) {
    throw new ReleaseNoteError(file, "a release needs at least one list item");
  }

  return { version, date, title, summary, sections, githubUrl };
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** Newest first: by version, then by date. Throws on a repeated version. */
export function sortReleases(releases: ReleaseNote[]): ReleaseNote[] {
  const seen = new Set<string>();
  for (const r of releases) {
    if (seen.has(r.version)) {
      throw new ReleaseNoteError(`v${r.version}.md`, "version listed twice");
    }
    seen.add(r.version);
  }
  return [...releases].sort(
    (a, b) =>
      compareSemver(b.version, a.version) || b.date.localeCompare(a.date),
  );
}

/** Split an item into plain and `**bold**` runs. Unpaired `**` stays literal. */
export function parseInline(text: string): ReleaseTextRun[] {
  const runs: ReleaseTextRun[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) runs.push({ text: text.slice(last, at), strong: false });
    runs.push({ text: m[1], strong: true });
    last = at + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), strong: false });
  return runs;
}

/** Item text with the markup removed (feeds, JSON-LD, plain-text uses). */
export function plainText(text: string): string {
  return parseInline(text)
    .map((r) => r.text)
    .join("");
}

/** A release date (YYYY-MM-DD) as a UTC-midnight Date. */
export function releaseDate(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** "17 October 2026" — formatted in UTC so the calendar day never shifts. */
export function formatReleaseDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

// ── Outputs ──────────────────────────────────────────────────────────────

/**
 * schema.org JSON-LD for `/releases`: a `CollectionPage` whose `mainEntity`
 * is an `ItemList` of `SoftwareApplication` versions (`softwareVersion`,
 * `datePublished`, `releaseNotes` → the entry's anchor), plus the page's
 * `BreadcrumbList`.
 */
export function releasesJsonLd(releases: ReleaseNote[], siteUrl: string) {
  const pageUrl = `${siteUrl}/releases`;
  const collectionPage = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "@id": pageUrl,
    url: pageUrl,
    name: "mukoko weather release notes",
    description: "What changed in each release of mukoko weather.",
    inLanguage: "en",
    ...(releases[0] ? { dateModified: releases[0].date } : {}),
    isPartOf: { "@type": "WebSite", url: siteUrl, name: "mukoko weather" },
    mainEntity: {
      "@type": "ItemList",
      itemListOrder: "https://schema.org/ItemListOrderDescending",
      numberOfItems: releases.length,
      itemListElement: releases.map((r, i) => ({
        "@type": "ListItem",
        position: i + 1,
        item: {
          "@type": "SoftwareApplication",
          name: "mukoko weather",
          applicationCategory: "WeatherApplication",
          operatingSystem: "Any",
          url: siteUrl,
          softwareVersion: r.version,
          datePublished: r.date,
          headline: r.title,
          releaseNotes: `${pageUrl}#${releaseAnchor(r.version)}`,
          ...(r.githubUrl ? { sameAs: r.githubUrl } : {}),
        },
      })),
    },
  };
  const breadcrumbs = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: siteUrl },
      {
        "@type": "ListItem",
        position: 2,
        name: "Release notes",
        item: pageUrl,
      },
    ],
  };
  return [collectionPage, breadcrumbs] as const;
}

/** Escape text for XML element content and attribute values. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One release as an HTML fragment (for the feed's `content`). */
export function releaseToHtml(release: ReleaseNote): string {
  const inline = (text: string) =>
    parseInline(text)
      .map((r) =>
        r.strong
          ? `<strong>${escapeHtml(r.text)}</strong>`
          : escapeHtml(r.text),
      )
      .join("");
  const parts = release.summary.map((p) => `<p>${inline(p)}</p>`);
  for (const s of release.sections) {
    parts.push(`<h2>${escapeHtml(s.heading)}</h2>`);
    parts.push(
      `<ul>${s.items.map((i) => `<li>${inline(i)}</li>`).join("")}</ul>`,
    );
  }
  return parts.join("");
}

/**
 * Atom 1.0 feed (RFC 4287). `updated` is the newest release's date, never the
 * clock, so the feed only changes when a release does.
 */
export function buildReleasesAtomFeed(
  releases: ReleaseNote[],
  siteUrl: string,
): string {
  const pageUrl = `${siteUrl}/releases`;
  const feedUrl = `${pageUrl}/feed.xml`;
  const stamp = (date: string) => `${date}T00:00:00Z`;
  const updated = stamp(releases[0]?.date ?? "1970-01-01");
  const entries = releases.map((r) => {
    const url = `${pageUrl}#${releaseAnchor(r.version)}`;
    return [
      "  <entry>",
      `    <id>${escapeXml(url)}</id>`,
      `    <title>${escapeXml(`v${r.version}: ${r.title}`)}</title>`,
      `    <link rel="alternate" type="text/html" href="${escapeXml(url)}"/>`,
      `    <published>${stamp(r.date)}</published>`,
      `    <updated>${stamp(r.date)}</updated>`,
      ...(r.summary.length
        ? [
            `    <summary>${escapeXml(r.summary.map(plainText).join(" "))}</summary>`,
          ]
        : []),
      `    <content type="html">${escapeXml(releaseToHtml(r))}</content>`,
      "  </entry>",
    ].join("\n");
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>${escapeXml(feedUrl)}</id>`,
    "  <title>mukoko weather release notes</title>",
    "  <subtitle>What changed in each release of mukoko weather.</subtitle>",
    `  <link rel="self" type="application/atom+xml" href="${escapeXml(feedUrl)}"/>`,
    `  <link rel="alternate" type="text/html" href="${escapeXml(pageUrl)}"/>`,
    `  <updated>${updated}</updated>`,
    "  <author><name>mukoko weather</name></author>",
    `  <icon>${escapeXml(`${siteUrl}/icon-192.png`)}</icon>`,
    ...entries,
    "</feed>",
    "",
  ].join("\n");
}
