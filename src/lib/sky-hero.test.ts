/**
 * The Quick actions group's tone logic: which hero is on the page (the
 * registry), and whether bare sky is still behind the group (an
 * IntersectionObserver on the hero's content, never a scroll listener). The
 * CSS that turns those answers into the clear and the solid look is held by
 * hero.test.ts and viewport-layout.test.ts; the real browser run is
 * scripts/browser-check/quick-actions.mjs.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  getSkyHero,
  registerSkyHero,
  skyBandRootMargin,
  subscribeSkyHero,
  watchSkyBehindGroup,
  type ObserveWindow,
} from "./sky-hero";

const source = readFileSync(resolve(__dirname, "sky-hero.ts"), "utf-8");

const el = (tag = "div") => ({ tag }) as unknown as HTMLElement;

describe("the sky hero registry", () => {
  it("starts empty, and holds the hero that registered with its place", () => {
    const content = el();
    const off = registerSkyHero(content, { name: "Harare", slug: "harare" });
    expect(getSkyHero()).toEqual({
      content,
      place: { name: "Harare", slug: "harare" },
    });
    off();
    expect(getSkyHero()).toBeNull();
  });

  it("holds a hero without a place (the loading skeleton)", () => {
    const off = registerSkyHero(el(), null);
    expect(getSkyHero()?.place).toBeNull();
    off();
  });

  it("tells subscribers on every change, and stops after unsubscribe", () => {
    const seen = vi.fn();
    const stop = subscribeSkyHero(seen);
    const off = registerSkyHero(el(), null);
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    expect(seen).toHaveBeenCalledTimes(2);
    stop();
    registerSkyHero(el(), null)();
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("is not undone by an older hero unmounting after a newer one registered (the skeleton giving way to the hero)", () => {
    const skeleton = registerSkyHero(el("skeleton"), null);
    const content = el("hero");
    const hero = registerSkyHero(content, { name: "Harare" });
    skeleton();
    expect(getSkyHero()?.content).toBe(content);
    hero();
    expect(getSkyHero()).toBeNull();
  });
});

describe("skyBandRootMargin: the root is everything from far above the page down to the group's bottom edge", () => {
  it("shrinks the root's bottom edge up to the group's bottom edge", () => {
    // A phone: the group is 16px down and 57px tall, on an 852px screen.
    expect(skyBandRootMargin(73, 852)).toBe("100000px 0px -779px 0px");
    // Desktop: the group in the header row, 10px down, 800px screen.
    expect(skyBandRootMargin(67, 800)).toBe("100000px 0px -733px 0px");
  });

  it("rounds to whole pixels and never goes the wrong way", () => {
    expect(skyBandRootMargin(72.6, 852)).toBe("100000px 0px -779px 0px");
    // A group not laid out (bottom 0) leaves the whole viewport as the band.
    expect(skyBandRootMargin(0, 852)).toBe("100000px 0px -852px 0px");
    // A band edge past the bottom of a short viewport leaves no negative gap.
    expect(skyBandRootMargin(900, 800)).toBe("100000px 0px 0px 0px");
    expect(skyBandRootMargin(Number.NaN, 800)).toBe("100000px 0px -800px 0px");
  });
});

/** An IntersectionObserver that records how it was made and lets a test answer for it. */
class FakeObserver {
  static made: FakeObserver[] = [];
  observed: unknown[] = [];
  disconnected = false;
  constructor(
    public callback: (entries: { isIntersecting: boolean }[]) => void,
    public options: IntersectionObserverInit,
  ) {
    FakeObserver.made.push(this);
  }
  observe(target: unknown) {
    this.observed.push(target);
  }
  disconnect() {
    this.disconnected = true;
  }
  answer(isIntersecting: boolean) {
    this.callback([{ isIntersecting }]);
  }
}

function fakeWindow(innerHeight = 852) {
  const listeners: Record<string, Array<() => void>> = {};
  const win = {
    innerHeight,
    IntersectionObserver:
      FakeObserver as unknown as typeof IntersectionObserver,
    addEventListener: (type: string, fn: () => void) => {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
    requestAnimationFrame: (fn: () => void) => {
      fn();
      return 1;
    },
    cancelAnimationFrame: () => undefined,
  } satisfies ObserveWindow;
  return { win, listeners };
}

const group = (bottom: number) =>
  ({ getBoundingClientRect: () => ({ bottom }) }) as unknown as Element;

describe("watchSkyBehindGroup: bare sky is behind the group until the hero's content reaches it", () => {
  const content = {} as Element;

  it("observes the hero's content with the band under the group, at threshold 0", () => {
    FakeObserver.made = [];
    const { win } = fakeWindow(852);
    watchSkyBehindGroup({ content, group: group(73), onChange: vi.fn(), win });
    expect(FakeObserver.made).toHaveLength(1);
    expect(FakeObserver.made[0].observed).toEqual([content]);
    expect(FakeObserver.made[0].options).toEqual({
      rootMargin: "100000px 0px -779px 0px",
      threshold: 0,
    });
  });

  it("is behind while the content is clear of the band, and not once it intersects", () => {
    FakeObserver.made = [];
    const { win } = fakeWindow();
    const onChange = vi.fn();
    watchSkyBehindGroup({ content, group: group(73), onChange, win });
    const observer = FakeObserver.made[0];
    observer.answer(false); // at the top of the page: only sky under the group
    expect(onChange).toHaveBeenLastCalledWith(true);
    observer.answer(true); // the page moved: the place name is under the group
    expect(onChange).toHaveBeenLastCalledWith(false);
    observer.answer(false); // back at the top
    expect(onChange).toHaveBeenLastCalledWith(true);
  });

  it("takes the newest entry when the browser batches several", () => {
    FakeObserver.made = [];
    const { win } = fakeWindow();
    const onChange = vi.fn();
    watchSkyBehindGroup({ content, group: group(73), onChange, win });
    FakeObserver.made[0].callback([
      { isIntersecting: true },
      { isIntersecting: false },
    ]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(true);
  });

  it("observes again when the window is resized, with the band the new layout gives", () => {
    FakeObserver.made = [];
    const { win, listeners } = fakeWindow(852);
    let bottom = 73;
    const moving = {
      getBoundingClientRect: () => ({ bottom }),
    } as unknown as Element;
    watchSkyBehindGroup({
      content,
      group: moving,
      onChange: vi.fn(),
      win,
    });
    expect(listeners.resize).toHaveLength(1);
    bottom = 67;
    win.innerHeight = 800;
    listeners.resize[0]();
    expect(FakeObserver.made).toHaveLength(2);
    expect(FakeObserver.made[0].disconnected).toBe(true);
    expect(FakeObserver.made[1].options.rootMargin).toBe(
      "100000px 0px -733px 0px",
    );
  });

  it("disconnects and stops listening when cleaned up", () => {
    FakeObserver.made = [];
    const { win, listeners } = fakeWindow();
    const stop = watchSkyBehindGroup({
      content,
      group: group(73),
      onChange: vi.fn(),
      win,
    });
    stop();
    expect(FakeObserver.made[0].disconnected).toBe(true);
    expect(listeners.resize).toHaveLength(0);
  });

  it("answers 'not behind' (the solid look, which reads on anything) where there is no IntersectionObserver", () => {
    const { win } = fakeWindow();
    const onChange = vi.fn();
    const stop = watchSkyBehindGroup({
      content,
      group: group(73),
      onChange,
      win: { ...win, IntersectionObserver: undefined },
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(() => stop()).not.toThrow();
  });

  it("never listens to scroll", () => {
    expect(source).not.toMatch(/["']scroll["']/);
    expect(source).not.toContain("scrollY");
    expect(source).not.toContain("getBoundingClientRect().top");
    expect(source).toContain("new Observer(");
  });
});
