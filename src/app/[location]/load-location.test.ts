import { describe, it, expect, vi } from "vitest";
import type { LocationDoc } from "@/lib/db";

vi.mock("@/lib/db", () => ({ getLocationFromDb: vi.fn() }));

const { resolveLocationForPage } = await import("./load-location");

const SHORT = { seed: 30, other: 60 };

describe("resolveLocationForPage: a shipped place never 404s (#414)", () => {
  it.each(["harare", "nairobi-ke", "lagos-ng", "singapore-sg"])(
    "%s renders from the seed when the lookup throws",
    async (slug) => {
      const loc = await resolveLocationForPage(
        slug,
        async () => {
          throw new Error("MongoServerSelectionError");
        },
        SHORT,
      );
      expect(loc?.slug).toBe(slug);
    },
  );

  it("renders from the seed when the lookup hangs, without waiting for it", async () => {
    const started = Date.now();
    const loc = await resolveLocationForPage(
      "harare",
      () => new Promise<LocationDoc | null>(() => undefined),
      SHORT,
    );
    expect(loc?.slug).toBe("harare");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("renders from the seed when the lookup answers null for a shipped slug", async () => {
    const loc = await resolveLocationForPage("harare", async () => null, SHORT);
    expect(loc?.name).toBe("Harare");
    expect(loc?.country).toBe("ZW");
  });

  it("prefers the lookup's own answer when there is one", async () => {
    const doc = { slug: "harare", name: "Harare (stored)" } as LocationDoc;
    expect(await resolveLocationForPage("harare", async () => doc, SHORT)).toBe(
      doc,
    );
  });

  it("still 404s a slug nobody knows, whether the lookup says null, throws or hangs", async () => {
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

  it("gives a non-shipped slug the longer wait (it may need the Worker too)", async () => {
    const slow = new Promise<LocationDoc | null>((resolve) =>
      setTimeout(() => resolve({ slug: "sembawang-sg" } as LocationDoc), 45),
    );
    const loc = await resolveLocationForPage("sembawang-sg", () => slow, SHORT);
    expect(loc?.slug).toBe("sembawang-sg");
  });
});
