/**
 * Build-time loader for the curated release notes in `releases/`.
 *
 * Server-only (reads the filesystem). `/releases` and `/releases/feed.xml`
 * are statically generated, so this runs during `next build`, never on the
 * request path, and never calls GitHub. A malformed file throws and fails
 * the build instead of shipping a broken page.
 *
 * This only works because those routes are `force-static`: Vercel's file
 * tracing does not see a `readdirSync(process.cwd() + "/releases")`, so
 * `releases/` is NOT bundled into a serverless function. A dynamic caller
 * must list `./releases/*.md` in `outputFileTracingIncludes` (next.config.ts),
 * as the sitemap does, and must survive the folder being missing.
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  parseReleaseNote,
  sortReleases,
  type ReleaseNote,
} from "@/lib/release-notes";

/** `releases/` at the repo root (Next runs builds from the project root). */
export const RELEASES_DIR = join(process.cwd(), "releases");

/** Release files are exactly `vX.Y.Z.md`; anything else in the folder is ignored. */
const RELEASE_FILE_RE = /^v\d+\.\d+\.\d+\.md$/;

/** Every release in `dir`, newest first. */
export function loadReleaseNotes(dir: string = RELEASES_DIR): ReleaseNote[] {
  const files = readdirSync(dir).filter((f) => RELEASE_FILE_RE.test(f));
  return sortReleases(
    files.map((file) =>
      parseReleaseNote(readFileSync(join(dir, file), "utf-8"), file),
    ),
  );
}
