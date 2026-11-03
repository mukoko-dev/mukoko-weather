import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handlePlaceLinkClick,
  hasPlaceStage,
  isPlainLeftClick,
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

describe("isPlainLeftClick", () => {
  const click = (over: Record<string, unknown> = {}) => ({
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault: () => undefined,
    ...over,
  });

  it("is true for a plain left click", () => {
    expect(isPlainLeftClick(click())).toBe(true);
  });

  it.each([
    ["middle click", { button: 1 }],
    ["right click", { button: 2 }],
    ["cmd click", { metaKey: true }],
    ["ctrl click", { ctrlKey: true }],
    ["shift click", { shiftKey: true }],
    ["alt click", { altKey: true }],
    ["already handled", { defaultPrevented: true }],
  ])(
    "is false for a %s (a new tab or window, not a switch in this tab)",
    (_name, over) => {
      expect(isPlainLeftClick(click(over))).toBe(false);
    },
  );

  it("is the rule handlePlaceLinkClick applies: a modified click is left to the browser", () => {
    const preventDefault = vi.fn();
    const push = vi.fn();
    handlePlaceLinkClick(
      click({ metaKey: true, preventDefault }),
      "/harare",
      push,
    );
    expect(preventDefault).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    handlePlaceLinkClick(click({ preventDefault }), "/harare", push);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/harare");
  });
});
