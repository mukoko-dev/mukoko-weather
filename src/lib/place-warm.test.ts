import { describe, expect, it } from "vitest";
import {
  WARM_PAUSE_AFTER_FAILURE_MS,
  WARM_PLACES,
  WARM_PLACES_CONSTRAINED,
  warmLimit,
  warmPass,
  warmTargets,
} from "./place-warm";
import type { WarmResult } from "./place-controller";
import type { PlaceTarget } from "./place-target";
import type { DeviceHints } from "./lazy-visibility";
import { pagerSequence } from "./location-pager";
import { canonicalSlug } from "./slug-migration";

const phone: DeviceHints = { viewportWidth: 393, viewportHeight: 852 };

describe("warmLimit: how many places to get ready", () => {
  it("four on a capable device, two each way", () => {
    expect(warmLimit(phone, true)).toBe(WARM_PLACES);
    expect(WARM_PLACES).toBe(4);
    expect(warmLimit({ ...phone, deviceMemory: 8 }, true)).toBe(WARM_PLACES);
  });

  it("only the next place on a low-memory device", () => {
    expect(warmLimit({ ...phone, deviceMemory: 2 }, true)).toBe(
      WARM_PLACES_CONSTRAINED,
    );
    expect(warmLimit({ ...phone, deviceMemory: 1 }, true)).toBe(1);
  });

  it("none with Save-Data on, however much memory there is", () => {
    expect(warmLimit({ ...phone, saveData: true }, true)).toBe(0);
    expect(warmLimit({ ...phone, saveData: true, deviceMemory: 8 }, true)).toBe(
      0,
    );
  });

  it("none while offline", () => {
    expect(warmLimit(phone, false)).toBe(0);
  });
});

describe("warmTargets: which places, nearest first", () => {
  const seq = ["/", "/a", "/b", "/c", "/d"];
  const slugs = (t: ReturnType<typeof warmTargets>) =>
    t.map((x) => (x.kind === "home" ? "/" : x.slug));

  it("the next page, the previous one, then outwards", () => {
    expect(slugs(warmTargets(seq, "/b", 4))).toEqual(["c", "a", "d", "/"]);
    expect(slugs(warmTargets(seq, "/b", 2))).toEqual(["c", "a"]);
    expect(slugs(warmTargets(seq, "/b", 1))).toEqual(["c"]);
  });

  it("at either end it walks the one side that exists", () => {
    expect(slugs(warmTargets(seq, "/", 4))).toEqual(["a", "b", "c", "d"]);
    expect(slugs(warmTargets(seq, "/d", 3))).toEqual(["c", "b", "a"]);
  });

  it("never includes the page on screen, and a sub-route counts as its place", () => {
    expect(slugs(warmTargets(seq, "/b/forecast", 10))).not.toContain("b");
    expect(slugs(warmTargets(seq, "/b/forecast", 1))).toEqual(["c"]);
  });

  it("is empty for a page outside the pager, or with no limit", () => {
    expect(warmTargets(seq, "/zzz", 4)).toEqual([]);
    expect(warmTargets(seq, "/explore", 4)).toEqual([]);
    expect(warmTargets(seq, "/b", 0)).toEqual([]);
    expect(warmTargets(seq, "/b", -1)).toEqual([]);
    expect(warmTargets(seq, "/b", Number.NaN)).toEqual([]);
    expect(warmTargets([], "/", 4)).toEqual([]);
  });

  it("counts only places it can warm toward the limit, and never repeats one", () => {
    const odd = ["/", "/a", "/explore", "/a", "/b"];
    // "/explore" is a route, not a place; "/a" appears twice.
    expect(slugs(warmTargets(odd, "/", 3))).toEqual(["a", "b"]);
  });

  it("works on the real pager sequence (My Location first, saved places after)", () => {
    const real = pagerSequence(["harare", "bulawayo"], []);
    expect(slugs(warmTargets(real, `/${canonicalSlug("harare")}`, 4))).toEqual([
      canonicalSlug("bulawayo"),
      "/",
    ]);
  });
});

describe("warming only what the visitor chose", () => {
  it("a sequence of saved places alone never offers a suggested place", () => {
    const saved = pagerSequence(["harare", "bulawayo"], []);
    const withSuggested = pagerSequence(["harare", "bulawayo"], ["nairobi-ke"]);
    const slugs = (t: ReturnType<typeof warmTargets>) =>
      t.map((x) => (x.kind === "home" ? "/" : x.slug));
    const bulawayo = `/${canonicalSlug("bulawayo")}`;
    expect(slugs(warmTargets(saved, bulawayo, 4))).not.toContain(
      canonicalSlug("nairobi-ke"),
    );
    // The same call over the longer sequence WOULD have warmed it.
    expect(slugs(warmTargets(withSuggested, bulawayo, 4))).toContain(
      canonicalSlug("nairobi-ke"),
    );
  });
});

describe("warmPass: one at a time, patient, and it stops when told to", () => {
  const targets: PlaceTarget[] = [
    { kind: "slug", slug: "a" },
    { kind: "slug", slug: "b" },
    { kind: "slug", slug: "c" },
  ];
  const visible = () => Promise.resolve();

  it("warms every target in order and says it is done", async () => {
    const seen: string[] = [];
    const end = await warmPass(
      targets,
      async (t) => {
        seen.push(t.kind === "slug" ? t.slug : "/");
        return "warmed";
      },
      { signal: new AbortController().signal, untilVisible: visible },
    );
    expect(end).toBe("done");
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("a failed place ends the pass: the rest are not asked", async () => {
    const seen: string[] = [];
    const end = await warmPass(
      targets,
      async (t) => {
        seen.push(t.kind === "slug" ? t.slug : "/");
        return seen.length === 1 ? "failed" : "warmed";
      },
      { signal: new AbortController().signal, untilVisible: visible },
    );
    expect(end).toBe("failed");
    expect(seen).toEqual(["a"]);
  });

  it("a skipped or fresh place does not end it", async () => {
    const results: WarmResult[] = ["fresh", "skipped", "warmed"];
    let i = 0;
    const end = await warmPass(targets, async () => results[i++], {
      signal: new AbortController().signal,
      untilVisible: visible,
    });
    expect(end).toBe("done");
    expect(i).toBe(3);
  });

  it("a hidden tab waits and carries on when it is visible again, instead of giving up", async () => {
    let show!: () => void;
    const hidden = new Promise<void>((resolve) => {
      show = resolve;
    });
    const seen: string[] = [];
    let waits = 0;
    const pass = warmPass(
      targets,
      async (t) => {
        seen.push(t.kind === "slug" ? t.slug : "/");
        return "warmed";
      },
      {
        signal: new AbortController().signal,
        // Hidden for the first wait only.
        untilVisible: () => (waits++ === 0 ? hidden : Promise.resolve()),
      },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([]);
    show();
    expect(await pass).toBe("done");
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("an abort stops it before the next place, even while it waits for the tab", async () => {
    const stop = new AbortController();
    const seen: string[] = [];
    const end = await warmPass(
      targets,
      async (t) => {
        seen.push(t.kind === "slug" ? t.slug : "/");
        stop.abort();
        return "warmed";
      },
      { signal: stop.signal, untilVisible: visible },
    );
    expect(end).toBe("stopped");
    expect(seen).toEqual(["a"]);
  });

  it("pauses warming for a minute after a failure", () => {
    expect(WARM_PAUSE_AFTER_FAILURE_MS).toBe(60_000);
  });
});
