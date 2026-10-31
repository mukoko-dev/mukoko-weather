/**
 * NotFoundView is the one not-found layout: it sits in PageShell (so the
 * bottom-nav clearance and the single main landmark come with it), uses the
 * fauna classes, and the explore not-found pages are thin copy wrappers over it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const read = (p: string) => readFileSync(resolve(__dirname, p), "utf-8");

const view = read("NotFoundView.tsx");
const country = read("../../app/explore/country/[code]/not-found.tsx");
const province = read(
  "../../app/explore/country/[code]/[province]/not-found.tsx",
);

describe("NotFoundView", () => {
  it("is built on PageShell, not a hand-rolled <main> or Header/Footer", () => {
    expect(view).toContain("<PageShell");
    expect(view).not.toMatch(/<main[\s>]/);
    expect(view).not.toContain("<Header");
    expect(view).not.toContain("<Footer");
  });

  it("uses the fauna classes: elephant heading, gazelle copy, kudu primary, impala secondary", () => {
    expect(view).toContain('className="elephant"');
    expect(view).toContain('className="gazelle');
    expect(view).toContain('"kudu"');
    expect(view).toContain('"impala"');
  });

  it("has no inline styles or hardcoded colours", () => {
    expect(view).not.toContain("style={{");
    expect(view).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});

describe("explore not-found pages", () => {
  for (const [name, src] of [
    ["country", country],
    ["province", province],
  ] as const) {
    it(`${name}: renders ExploreNotFound (shared explore actions in NotFoundView)`, () => {
      expect(src).toContain("ExploreNotFound");
      expect(view).toContain("EXPLORE_NOT_FOUND_ACTIONS");
      expect(src).not.toContain("<Header");
      expect(src).not.toContain("<Footer");
      expect(src).not.toMatch(/id="main-content"/);
    });
  }
});
