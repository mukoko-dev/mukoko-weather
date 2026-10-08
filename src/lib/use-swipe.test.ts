import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  NO_SWIPE_ATTRIBUTE,
  SWIPE_DOMINANCE_RATIO,
  SWIPE_MIN_DISTANCE_PX,
  classifySwipe,
  isSwipeExcluded,
} from "./use-swipe";

describe("classifySwipe — direction and thresholds", () => {
  it("classifies a long, clearly horizontal left move as left", () => {
    expect(classifySwipe(-120, 10)).toBe("left");
  });

  it("classifies a long, clearly horizontal right move as right", () => {
    expect(classifySwipe(120, -5)).toBe("right");
  });

  it("uses a 60px minimum horizontal distance", () => {
    expect(SWIPE_MIN_DISTANCE_PX).toBe(60);
    expect(classifySwipe(-59, 0)).toBeNull();
    expect(classifySwipe(59, 0)).toBeNull();
    expect(classifySwipe(-60, 0)).toBe("left");
    expect(classifySwipe(60, 0)).toBe("right");
  });

  it("requires |dx| to exceed 1.5x |dy| (mostly horizontal)", () => {
    expect(SWIPE_DOMINANCE_RATIO).toBe(1.5);
    // Exactly 1.5x is not enough — the rule is strictly greater than.
    expect(classifySwipe(-90, 60)).toBeNull();
    // Just over 1.5x counts.
    expect(classifySwipe(-91, 60)).toBe("left");
  });

  it("rejects a predominantly vertical gesture even when long", () => {
    expect(classifySwipe(70, 200)).toBeNull();
    expect(classifySwipe(-70, 300)).toBeNull();
  });

  it("returns null for a zero-length tap", () => {
    expect(classifySwipe(0, 0)).toBeNull();
  });

  it("accepts a custom threshold", () => {
    expect(classifySwipe(-30, 0, 20)).toBe("left");
    expect(classifySwipe(-30, 0)).toBeNull();
  });
});

describe("isSwipeExcluded — where a gesture starts", () => {
  // Vitest runs in a node environment with no DOM, so the element walk itself
  // is checked at source level; classifySwipe carries the pure logic tests.
  const source = readFileSync(resolve(__dirname, "use-swipe.ts"), "utf-8");

  it("returns false for a non-Element start (no DOM target to inspect)", () => {
    expect(isSwipeExcluded(null, null)).toBe(false);
  });

  it("documents the opt-out attribute name", () => {
    expect(NO_SWIPE_ATTRIBUTE).toBe("data-no-swipe");
  });

  it("stops the walk at the root and checks the opt-out attribute", () => {
    expect(source).toContain("el !== root");
    expect(source).toContain("hasAttribute(NO_SWIPE_ATTRIBUTE)");
  });

  it("treats only overflow-x auto/scroll with overflowing content as a scroller", () => {
    expect(source).toContain("el.scrollWidth <= el.clientWidth");
    expect(source).toContain('overflowX === "auto" || overflowX === "scroll"');
  });
});

describe("useSwipe — hook contract (source-level)", () => {
  const source = readFileSync(resolve(__dirname, "use-swipe.ts"), "utf-8");

  it("exposes touch start/end/cancel handlers and ignores multi-touch", () => {
    expect(source).toContain("onTouchStart");
    expect(source).toContain("onTouchEnd");
    expect(source).toContain("onTouchCancel");
    expect(source).toContain("event.touches.length !== 1");
  });

  it("reads callbacks through a ref so handlers are not re-bound each render", () => {
    expect(source).toContain("const callbacks = useRef");
    expect(source).toContain("[enabled],");
  });

  it("is a client module", () => {
    expect(source.startsWith('"use client";')).toBe(true);
  });
});
