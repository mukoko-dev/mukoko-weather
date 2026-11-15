import {
  parseReleaseNote,
  sortReleases,
  type ReleaseNote,
} from "@/lib/release-notes";

/**
 * The curated release notes in `releases/` at the repo root, read when the
 * site is built. The Next.js loader (`release-notes-source.ts`) reads the
 * folder with `fs`, which the prerender here (it runs in workerd, on the
 * Cloudflare adapter) does not have, so the files are pulled in by Vite
 * instead. Same files, same parser, same order: `releases.test.ts` checks the
 * two loaders agree.
 */
const files = import.meta.glob<string>("../../../releases/v*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Release files are exactly `vX.Y.Z.md`; anything else in the folder is ignored. */
const RELEASE_FILE_RE = /^v\d+\.\d+\.\d+\.md$/;

export function releases(): ReleaseNote[] {
  return sortReleases(
    Object.entries(files)
      .map(([path, source]) => [path.split("/").pop() ?? path, source] as const)
      .filter(([file]) => RELEASE_FILE_RE.test(file))
      .map(([file, source]) => parseReleaseNote(source, file)),
  );
}
