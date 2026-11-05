import { describe, it, expect, vi } from "vitest";
import type { LocationDoc } from "@/lib/db";
import { canonicalSlug } from "@/lib/slug-migration";

vi.mock("@/lib/db", () => ({ getLocationFromDb: vi.fn() }));

const { resolveLocationForPage } = await import("./load-location");

const SHORT = 60;

describe("resolveLocationForPage: a shipped place never waits and never 404s (#414, #452)", () => {
  it.each(["harare", "nairobi-ke", "lagos-ng", "singapore-sg"])(
    "%s renders from the seed, whatever the store would say",
    async (slug) => {
      const resolve = vi.fn(async () => {
        throw new Error("MongoServerSelectionError");
      });
      const loc = await resolveLocationForPage(slug, resolve, SHORT);
      // The page carries the canonical slug of a shipped place (#317).
      expect(loc?.slug).toBe(canonicalSlug(slug));
      // No lookup is made for a place the app ships.
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it("does not wait for a store that hangs", async () => {
    const started = Date.now();
    const loc = await resolveLocationForPage(
      "harare",
      () => new Promise<LocationDoc | null>(() => undefined),
      60_000,
    );
    expect(loc?.slug).toBe(canonicalSlug("harare"));
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("is the seed's own record (name, country), not the store's", async () => {
    const doc = { slug: "harare", name: "Harare (stored)" } as LocationDoc;
    const loc = await resolveLocationForPage("harare", async () => doc, SHORT);
    expect(loc?.name).toBe("Harare");
    expect(loc?.country).toBe("ZW");
  });
});

describe("resolveLocationForPage: a spot is named by its own slug", () => {
  it("answers with its coordinate and name, and lends no lookup", async () => {
    const resolve = vi.fn();
    const loc = await resolveLocationForPage("west-paddock--ksy4dd7", resolve);
    expect(loc?.slug).toBe("west-paddock--ksy4dd7");
    expect(loc?.name).toBe("West Paddock");
    expect(Number.isFinite(loc?.lat)).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("resolveLocationForPage: any other slug asks the store", () => {
  it("passes the store's answer through", async () => {
    const doc = { slug: "sembawang-sg", name: "Sembawang" } as LocationDoc;
    expect(
      await resolveLocationForPage("sembawang-sg", async () => doc, SHORT),
    ).toBe(doc);
  });

  it("is null for a slug nobody knows, whether the lookup says null, throws or hangs", async () => {
    expect(
      await resolveLocationForPage("nowhere-xx", async () => null, SHORT),
    ).toBeNull();
    expect(
      await resolveLocationForPage(
        "nowhere-xx",
        async () => {
          throw new Error("down");
        },
        SHORT,
      ),
    ).toBeNull();
    expect(
      await resolveLocationForPage(
        "nowhere-xx",
        () => new Promise<LocationDoc | null>(() => undefined),
        SHORT,
      ),
    ).toBeNull();
  });

  it("waits for a slow store up to its timeout", async () => {
    const slow = new Promise<LocationDoc | null>((resolve) =>
      setTimeout(() => resolve({ slug: "sembawang-sg" } as LocationDoc), 20),
    );
    const loc = await resolveLocationForPage("sembawang-sg", () => slow, 500);
    expect(loc?.slug).toBe("sembawang-sg");
  });
});
