import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasPlaceStage,
  navigateToPlace,
  registerPlaceStage,
} from "./place-bus";
import type { PlaceTarget } from "./place-target";

let unregister: (() => void) | null = null;
afterEach(() => {
  unregister?.();
  unregister = null;
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("navigateToPlace", () => {
  it("pushes when no stage is mounted", () => {
    const push = vi.fn();
    expect(hasPlaceStage()).toBe(false);
    navigateToPlace("/nairobi-ke", push);
    expect(push).toHaveBeenCalledWith("/nairobi-ke");
  });

  it("shows the place in the stage and does not push", async () => {
    const push = vi.fn();
    const show = vi.fn(async (_t: PlaceTarget) => true);
    unregister = registerPlaceStage({ canShow: () => true, show });
    navigateToPlace("/nairobi-ke", push);
    await flush();
    expect(show).toHaveBeenCalledWith({ kind: "slug", slug: "nairobi-ke" });
    expect(push).not.toHaveBeenCalled();
  });

  it("falls back to push when the stage cannot resolve the place", async () => {
    const push = vi.fn();
    unregister = registerPlaceStage({
      canShow: () => true,
      show: async () => false,
    });
    navigateToPlace("/nowhere-xx", push);
    await flush();
    expect(push).toHaveBeenCalledWith("/nowhere-xx");
  });

  it("falls back to push when the stage throws", async () => {
    const push = vi.fn();
    unregister = registerPlaceStage({
      canShow: () => true,
      show: async () => {
        throw new Error("boom");
      },
    });
    navigateToPlace("/nairobi-ke", push);
    await flush();
    expect(push).toHaveBeenCalledWith("/nairobi-ke");
  });

  it("pushes sub-routes and other routes even with a stage mounted", () => {
    const push = vi.fn();
    const show = vi.fn(async () => true);
    unregister = registerPlaceStage({ canShow: () => true, show });
    navigateToPlace("/nairobi-ke/forecast", push);
    navigateToPlace("/explore", push);
    navigateToPlace("/nairobi-ke?utm_source=x", push);
    expect(push.mock.calls.map((c) => c[0])).toEqual([
      "/nairobi-ke/forecast",
      "/explore",
      "/nairobi-ke?utm_source=x",
    ]);
    expect(show).not.toHaveBeenCalled();
  });

  it("pushes My Location when the stage does not know the home place", () => {
    const push = vi.fn();
    const show = vi.fn(async () => true);
    unregister = registerPlaceStage({
      canShow: (t) => t.kind === "slug",
      show,
    });
    navigateToPlace("/", push);
    expect(push).toHaveBeenCalledWith("/");
    expect(show).not.toHaveBeenCalled();
  });

  it("unregister only removes its own stage", () => {
    const a = registerPlaceStage({
      canShow: () => true,
      show: async () => true,
    });
    const off = registerPlaceStage({
      canShow: () => true,
      show: async () => true,
    });
    a(); // an older stage unmounting after a newer one took over
    expect(hasPlaceStage()).toBe(true);
    off();
    expect(hasPlaceStage()).toBe(false);
  });
});
