import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  SHEET_DISMISS_MAX_PX,
  SHEET_DISMISS_MIN_PX,
  SHEET_DRAG_ATTRIBUTE,
  SHEET_EXIT_MS,
  SHEET_FLING_MIN_PX,
  SHEET_FLING_VELOCITY,
  SHEET_NO_DRAG_SELECTOR,
  SHEET_REFUSAL_CHECK_MS,
  SHEET_REST_MS,
  SHEET_RESTORE_MS,
  attachSheetDrag,
  canScrollUp,
  decideRelease,
  dismissDistance,
  hasTravelled,
  nextVelocity,
  releaseVelocity,
  smoothVelocity,
  startsPull,
  type ScrollProbe,
} from "./sheet-drag";

/**
 * Pull down to dismiss (issue #482). The decisions are pure and tested first;
 * the DOM glue is then driven with a small fake element, so the state machine
 * (bar versus content, scrolled versus at the top, threshold versus fling,
 * reduced motion, desktop) is covered in node. What a real finger does to a
 * real browser is checked in scripts/browser-check/modal-sheet.mjs.
 */

describe("dismissDistance", () => {
  it("is a quarter of the sheet, never under 80px or over 160px", () => {
    expect(dismissDistance(200)).toBe(SHEET_DISMISS_MIN_PX);
    expect(dismissDistance(480)).toBe(120);
    expect(dismissDistance(2000)).toBe(SHEET_DISMISS_MAX_PX);
  });

  it("falls back to the minimum for a sheet with no usable height", () => {
    expect(dismissDistance(Number.NaN)).toBe(SHEET_DISMISS_MIN_PX);
    expect(dismissDistance(0)).toBe(SHEET_DISMISS_MIN_PX);
  });
});

describe("decideRelease", () => {
  const height = 600;
  const distance = dismissDistance(height);

  it("dismisses past the distance, however slowly", () => {
    expect(decideRelease({ offset: distance, velocity: 0, height })).toBe(
      "dismiss",
    );
    expect(decideRelease({ offset: distance + 40, velocity: 0, height })).toBe(
      "dismiss",
    );
  });

  it("springs back below the distance", () => {
    expect(decideRelease({ offset: distance - 1, velocity: 0, height })).toBe(
      "restore",
    );
    expect(decideRelease({ offset: 30, velocity: 0.1, height })).toBe(
      "restore",
    );
  });

  it("dismisses a fling from a short pull", () => {
    expect(
      decideRelease({
        offset: SHEET_FLING_MIN_PX,
        velocity: SHEET_FLING_VELOCITY,
        height,
      }),
    ).toBe("dismiss");
  });

  it("does not dismiss a fling that barely moved, or a slow pull", () => {
    expect(
      decideRelease({
        offset: SHEET_FLING_MIN_PX - 1,
        velocity: 3,
        height,
      }),
    ).toBe("restore");
    expect(
      decideRelease({
        offset: 60,
        velocity: SHEET_FLING_VELOCITY - 0.01,
        height,
      }),
    ).toBe("restore");
  });

  it("never dismisses an upward or empty pull", () => {
    expect(decideRelease({ offset: 0, velocity: 5, height })).toBe("restore");
    expect(decideRelease({ offset: -20, velocity: 5, height })).toBe("restore");
    expect(decideRelease({ offset: 50, velocity: -2, height })).toBe("restore");
  });
});

describe("reading a gesture", () => {
  it("a pull is down and at least as vertical as it is sideways", () => {
    expect(startsPull(0, 10)).toBe(true);
    expect(startsPull(10, 10)).toBe(true);
    expect(startsPull(12, 10)).toBe(false);
    expect(startsPull(0, -10)).toBe(false);
    expect(startsPull(0, 2)).toBe(false);
  });

  it("a gesture is read once it moved 3px either way", () => {
    expect(hasTravelled(0, 2)).toBe(false);
    expect(hasTravelled(3, 0)).toBe(true);
    expect(hasTravelled(0, -3)).toBe(true);
  });

  it("smooths the speed and ignores a zero interval", () => {
    expect(smoothVelocity(0, 10, 10)).toBeCloseTo(0.6);
    expect(smoothVelocity(1, 10, 10)).toBeCloseTo(1);
    expect(smoothVelocity(0.8, 10, 0)).toBe(0.8);
  });

  it("takes the first sample as it is, then smooths", () => {
    // A quick flick has two or three moves: the first must not be halved
    // against a zero nobody measured.
    expect(nextVelocity(0, 0, 30, 20)).toBeCloseTo(1.5);
    expect(nextVelocity(1.5, 1, 30, 20)).toBeCloseTo(1.5);
    expect(nextVelocity(1, 1, 0, 20)).toBeCloseTo(0.4);
    expect(nextVelocity(0.8, 3, 10, 0)).toBe(0.8);
  });

  it("a finger that rested before lifting has no speed", () => {
    expect(releaseVelocity(2, 1000, 1000 + SHEET_REST_MS)).toBe(2);
    expect(releaseVelocity(2, 1000, 1000 + SHEET_REST_MS + 1)).toBe(0);
  });
});

describe("canScrollUp", () => {
  const scroller = (over: Partial<ScrollProbe> = {}): ScrollProbe => ({
    overflowY: "auto",
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 400,
    ...over,
  });

  it("is false while every scroller on the way up is at its top", () => {
    expect(canScrollUp([scroller(), scroller({ overflowY: "visible" })])).toBe(
      false,
    );
  });

  it("is true when one scrolls and has been scrolled", () => {
    expect(canScrollUp([scroller({ scrollTop: 12 })])).toBe(true);
    expect(
      canScrollUp([
        scroller({ overflowY: "visible" }),
        scroller({ overflowY: "scroll", scrollTop: 1 }),
      ]),
    ).toBe(true);
  });

  it("ignores an element that cannot scroll", () => {
    expect(
      canScrollUp([scroller({ scrollTop: 50, overflowY: "hidden" })]),
    ).toBe(false);
    expect(canScrollUp([scroller({ scrollTop: 50, scrollHeight: 400 })])).toBe(
      false,
    );
  });
});

describe("where a pull may not start", () => {
  it("names fields, sliders, charts and the opt-out", () => {
    for (const token of [
      "input",
      "textarea",
      "select",
      "canvas",
      '[role="slider"]',
      "[data-no-sheet-drag]",
    ]) {
      expect(SHEET_NO_DRAG_SELECTOR).toContain(token);
    }
  });
});

// ── The DOM glue, with a fake element ──────────────────────────────────────

type Listener = (event: FakeEvent) => void;

interface FakeEvent {
  type?: string;
  target?: unknown;
  timeStamp: number;
  isPrimary?: boolean;
  pointerType?: string;
  pointerId?: number;
  button?: number;
  clientX?: number;
  clientY?: number;
  touches?: { identifier: number; clientX: number; clientY: number }[];
  cancelable?: boolean;
  preventDefault?: () => void;
}

/** Just enough of an Element for sheet-drag and use-swipe's exclusion walk. */
class FakeElement {
  tag: string;
  attrs = new Map<string, string>();
  parentElement: FakeElement | null = null;
  style: Record<string, string> = {};
  listeners = new Map<string, Set<Listener>>();
  isConnected = true;
  offsetHeight = 600;
  scrollTop = 0;
  scrollHeight = 600;
  clientHeight = 600;
  scrollWidth = 400;
  clientWidth = 400;
  overflowY = "visible";
  overflowX = "visible";
  captured: number[] = [];

  constructor(tag: string, parent: FakeElement | null = null) {
    this.tag = tag;
    this.parentElement = parent;
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name: string) {
    return this.attrs.has(name);
  }
  contains(other: FakeElement | null) {
    for (let node = other; node; node = node.parentElement) {
      if (node === this) return true;
    }
    return false;
  }
  private matches(selector: string) {
    return selector.split(",").some((part) => {
      const token = part.trim();
      const attr = token.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      if (attr) {
        return (
          this.attrs.has(attr[1]) &&
          (attr[2] === undefined || this.attrs.get(attr[1]) === attr[2])
        );
      }
      return token === this.tag;
    });
  }
  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) return this;
    return this.parentElement?.closest(selector) ?? null;
  }
  addEventListener(type: string, listener: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }
  setPointerCapture(id: number) {
    this.captured.push(id);
  }
  fire(type: string, event: FakeEvent) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ ...event, type });
    }
  }
  has(type: string) {
    return (this.listeners.get(type)?.size ?? 0) > 0;
  }
}

describe("attachSheetDrag", () => {
  let phone = true;
  let reduced = false;
  let sheet: FakeElement;
  let bar: FakeElement;
  let title: FakeElement;
  let closeButton: FakeElement;
  let body: FakeElement;
  let paragraph: FakeElement;
  let dismiss: Mock<() => void>;
  let detach: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    phone = true;
    reduced = false;
    vi.stubGlobal("Element", FakeElement);
    vi.stubGlobal("window", {
      matchMedia: (query: string) => ({
        matches: query.includes("prefers-reduced-motion")
          ? reduced
          : query.includes("min-width")
            ? !phone
            : false,
      }),
      getComputedStyle: (node: FakeElement) => ({
        overflowY: node.overflowY,
        overflowX: node.overflowX,
        transform: "none",
      }),
    });
    sheet = new FakeElement("div");
    sheet.overflowY = "auto";
    sheet.setAttribute("data-state", "open");
    bar = new FakeElement("div", sheet);
    bar.setAttribute(SHEET_DRAG_ATTRIBUTE, "");
    title = new FakeElement("h2", bar);
    closeButton = new FakeElement("button", bar);
    body = new FakeElement("div", sheet);
    paragraph = new FakeElement("p", body);
    dismiss = vi.fn<() => void>();
    detach = attachSheetDrag(sheet as unknown as HTMLElement, { dismiss });
  });

  afterEach(() => {
    detach();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const pointer = (type: string, y: number, at: number, target = title) =>
    sheet.fire(type, {
      target,
      isPrimary: true,
      pointerType: "touch",
      pointerId: 1,
      button: 0,
      clientX: 100,
      clientY: y,
      timeStamp: at,
    });

  const touch = (
    type: string,
    y: number,
    at: number,
    target: FakeElement = paragraph,
    preventDefault = vi.fn(),
  ) => {
    sheet.fire(type, {
      target,
      touches:
        type === "touchend" || type === "touchcancel"
          ? []
          : [{ identifier: 7, clientX: 100, clientY: y }],
      timeStamp: at,
      cancelable: true,
      preventDefault,
    });
    return preventDefault;
  };

  it("the sheet follows a finger on the bar, and closes past the distance", () => {
    pointer("pointerdown", 100, 0);
    pointer("pointermove", 120, 16);
    pointer("pointermove", 260, 600);
    expect(sheet.style.transform).toBe("translate3d(0, 160px, 0)");
    expect(sheet.captured).toEqual([1]);
    pointer("pointerup", 260, 1200);
    // It slides out first, then the dialog is closed through its own control.
    expect(sheet.style.transform).toBe("translate3d(0, 100%, 0)");
    expect(dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SHEET_EXIT_MS + 20);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(sheet.hasAttribute("data-sheet-closing")).toBe(true);
  });

  it("springs back when released short of the distance", () => {
    pointer("pointerdown", 100, 0);
    pointer("pointermove", 140, 300);
    pointer("pointermove", 150, 900);
    pointer("pointerup", 150, 1500);
    expect(sheet.style.transform).toBe("translate3d(0, 0, 0)");
    expect(dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SHEET_RESTORE_MS + 40);
    expect(sheet.style.transform).toBe("");
    expect(sheet.style.transition).toBe("");
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("closes on a fling from a short pull", () => {
    pointer("pointerdown", 100, 0);
    pointer("pointermove", 112, 8);
    pointer("pointermove", 140, 24);
    pointer("pointerup", 140, 40);
    vi.advanceTimersByTime(SHEET_EXIT_MS + 20);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("does not start from a control in the bar, or on a pull upwards", () => {
    pointer("pointerdown", 100, 0, closeButton);
    pointer("pointermove", 220, 100, closeButton);
    expect(sheet.style.transform ?? "").toBe("");
    pointer("pointerup", 220, 200, closeButton);

    pointer("pointerdown", 300, 300);
    pointer("pointermove", 270, 400);
    pointer("pointermove", 400, 500);
    expect(sheet.style.transform ?? "").toBe("");
    pointer("pointerup", 400, 600);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("the content can be pulled while it is at its top (touch)", () => {
    touch("touchstart", 300, 0);
    expect(sheet.has("touchmove")).toBe(true);
    const stop = touch("touchmove", 310, 16);
    expect(stop).toHaveBeenCalled();
    touch("touchmove", 460, 700);
    expect(sheet.style.transform).toBe("translate3d(0, 160px, 0)");
    touch("touchend", 460, 1300);
    expect(sheet.has("touchmove")).toBe(false);
    vi.advanceTimersByTime(SHEET_EXIT_MS + 20);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("leaves the browser's scroll alone once the content has been scrolled", () => {
    sheet.scrollTop = 40;
    sheet.scrollHeight = 1200;
    sheet.clientHeight = 600;
    touch("touchstart", 300, 0);
    expect(sheet.has("touchmove")).toBe(false);
    expect(sheet.style.transform ?? "").toBe("");
  });

  it("leaves an upward or sideways touch to the browser and stops listening", () => {
    touch("touchstart", 300, 0);
    const up = touch("touchmove", 280, 16);
    expect(up).not.toHaveBeenCalled();
    expect(sheet.has("touchmove")).toBe(false);
    expect(sheet.style.transform ?? "").toBe("");
  });

  it("never starts on a field, a chart, a no-swipe area or a sideways scroller", () => {
    const field = new FakeElement("input", body);
    const chart = new FakeElement("canvas", body);
    const noSwipe = new FakeElement("div", body);
    noSwipe.setAttribute("data-no-swipe", "");
    const strip = new FakeElement("div", body);
    strip.overflowX = "auto";
    strip.scrollWidth = 900;
    const cell = new FakeElement("span", strip);
    for (const target of [field, chart, noSwipe, cell]) {
      touch("touchstart", 300, 0, target);
      expect(sheet.has("touchmove")).toBe(false);
      touch("touchend", 300, 10, target);
    }
  });

  it("a touch on the bar belongs to the pointer path, not the touch path", () => {
    touch("touchstart", 100, 0, title);
    expect(sheet.has("touchmove")).toBe(false);
  });

  it("under reduced motion it still closes, with nothing animated", () => {
    reduced = true;
    pointer("pointerdown", 100, 0);
    pointer("pointermove", 120, 16);
    pointer("pointermove", 320, 400);
    pointer("pointerup", 320, 800);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(sheet.style.transition).toBe("none");
  });

  it("under reduced motion a short pull snaps back with no transition", () => {
    reduced = true;
    pointer("pointerdown", 100, 0);
    pointer("pointermove", 140, 400);
    pointer("pointerup", 140, 1000);
    expect(sheet.style.transform).toBe("");
    expect(sheet.style.transition).toBe("");
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("does nothing from the sm breakpoint, where the dialog is centred", () => {
    phone = false;
    pointer("pointerdown", 100, 0);
    pointer("pointermove", 400, 400);
    expect(sheet.style.transform ?? "").toBe("");
    touch("touchstart", 300, 0);
    expect(sheet.has("touchmove")).toBe(false);
  });

  it("a second finger cancels a pull and the sheet springs back", () => {
    touch("touchstart", 300, 0);
    touch("touchmove", 310, 16);
    touch("touchmove", 380, 500);
    sheet.fire("touchmove", {
      target: paragraph,
      touches: [
        { identifier: 7, clientX: 100, clientY: 380 },
        { identifier: 8, clientX: 200, clientY: 380 },
      ],
      timeStamp: 600,
      cancelable: true,
      preventDefault: vi.fn(),
    });
    expect(sheet.style.transform).toBe("translate3d(0, 0, 0)");
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("a dialog that refuses to close is not left off-screen", () => {
    pointer("pointerdown", 100, 0);
    pointer("pointermove", 120, 16);
    pointer("pointermove", 320, 400);
    pointer("pointerup", 320, 800);
    vi.advanceTimersByTime(SHEET_EXIT_MS + 20);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(sheet.hasAttribute("data-sheet-closing")).toBe(true);
    // data-state is still "open": the consumer refused. Within a moment the
    // sheet comes back, with a spring and not after a long blank wait.
    vi.advanceTimersByTime(SHEET_REFUSAL_CHECK_MS);
    expect(sheet.hasAttribute("data-sheet-closing")).toBe(false);
    expect(sheet.style.transform).toBe("translate3d(0, 0, 0)");
    vi.advanceTimersByTime(SHEET_RESTORE_MS + 40);
    expect(sheet.style.transform).toBe("");
  });

  it("a dialog that does begin to close is left to its own exit", () => {
    dismiss.mockImplementation(() =>
      sheet.setAttribute("data-state", "closed"),
    );
    pointer("pointerdown", 100, 0);
    pointer("pointermove", 120, 16);
    pointer("pointermove", 320, 400);
    pointer("pointerup", 320, 800);
    vi.advanceTimersByTime(SHEET_EXIT_MS + 20 + SHEET_REFUSAL_CHECK_MS + 500);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(sheet.hasAttribute("data-sheet-closing")).toBe(true);
    expect(sheet.style.transform).toBe("translate3d(0, 100%, 0)");
  });

  it("a short, quick flick closes it (the first move is not smoothed away)", () => {
    pointer("pointerdown", 100, 0);
    pointer("pointermove", 130, 20); // 30px in 20ms
    pointer("pointerup", 130, 30);
    vi.advanceTimersByTime(SHEET_EXIT_MS + 20);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("does not take a pull while the slide-up animation still runs", () => {
    (sheet as unknown as { getAnimations: () => unknown[] }).getAnimations =
      () => [{ animationName: "slide-up", playState: "running" }];
    pointer("pointerdown", 100, 0);
    pointer("pointermove", 160, 100);
    pointer("pointermove", 300, 200);
    pointer("pointerup", 300, 300);
    expect(sheet.style.transform ?? "").toBe("");
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("a running transition (a spring in flight) does not stop a new pull", () => {
    (sheet as unknown as { getAnimations: () => unknown[] }).getAnimations =
      () => [{ transitionProperty: "transform", playState: "running" }];
    pointer("pointerdown", 100, 0);
    pointer("pointermove", 160, 100);
    expect(sheet.style.transform).toBe("translate3d(0, 60px, 0)");
  });

  it("removes every listener when detached", () => {
    detach();
    pointer("pointerdown", 100, 0);
    pointer("pointermove", 400, 400);
    expect(sheet.style.transform ?? "").toBe("");
    for (const type of [
      "pointerdown",
      "pointermove",
      "pointerup",
      "pointercancel",
      "touchstart",
      "touchmove",
      "touchend",
      "touchcancel",
    ]) {
      expect(sheet.has(type)).toBe(false);
    }
  });
});
