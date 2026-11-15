import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadReleaseNotes } from "@/lib/release-notes-source";
import { releases } from "./releases";

describe("releases (the build-time loader of this app)", () => {
  it("returns the same notes, in the same order, as the Next.js loader", () => {
    const dir = join(
      fileURLToPath(new URL("../../..", import.meta.url)),
      "releases",
    );
    const expected = loadReleaseNotes(dir);
    expect(expected.length).toBeGreaterThan(0);
    expect(releases()).toEqual(expected);
  });
});
