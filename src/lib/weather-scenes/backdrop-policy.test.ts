import { describe, it, expect } from "vitest";
import {
  backdropMode,
  motionAllowed,
  readBackdropHints,
  shouldAnimateBackdrop,
  shouldRunBackdrop,
  SKY_VISIBLE_VIEWPORTS,
} from "./backdrop-policy";

describe("shouldAnimateBackdrop", () => {
  const capable = {
    reducedMotion: false,
    deviceMemory: 8,
  };

  it("animates on a capable device", () => {
    expect(shouldAnimateBackdrop(capable)).toBe(true);
  });

  it("animates when the browser does not report memory", () => {
    expect(shouldAnimateBackdrop({ reducedMotion: false })).toBe(true);
  });

  it("keeps the static sky for prefers-reduced-motion", () => {
    expect(shouldAnimateBackdrop({ ...capable, reducedMotion: true })).toBe(
      false,
    );
  });

  it("keeps the static sky under Save-Data", () => {
    expect(shouldAnimateBackdrop({ ...capable, saveData: true })).toBe(false);
  });

  it("keeps the static sky on ≤ 2 GB devices", () => {
    expect(shouldAnimateBackdrop({ ...capable, deviceMemory: 2 })).toBe(false);
    expect(shouldAnimateBackdrop({ ...capable, deviceMemory: 1 })).toBe(false);
  });

  it("does not treat a reported core count of 2 as low-end (older iOS, Firefox RFP)", () => {
    const iphone = {
      reducedMotion: false,
      hardwareConcurrency: 2,
    } as Parameters<typeof shouldAnimateBackdrop>[0];
    expect(shouldAnimateBackdrop(iphone)).toBe(true);
  });

  it("is static on the server (no window)", () => {
    expect(shouldAnimateBackdrop(readBackdropHints())).toBe(false);
  });
});

describe("shouldRunBackdrop", () => {
  const base = {
    tabVisible: true,
    scrolling: false,
    scrollY: 0,
    viewportHeight: 900,
  };

  it("runs at the top of a visible page", () => {
    expect(shouldRunBackdrop(base)).toBe(true);
  });

  it("idles in a hidden tab", () => {
    expect(shouldRunBackdrop({ ...base, tabVisible: false })).toBe(false);
  });

  it("idles while the reader is scrolling", () => {
    expect(shouldRunBackdrop({ ...base, scrolling: true })).toBe(false);
  });

  it("idles once the sky region has scrolled away", () => {
    expect(
      shouldRunBackdrop({
        ...base,
        scrollY: 900 * SKY_VISIBLE_VIEWPORTS + 1,
      }),
    ).toBe(false);
    expect(shouldRunBackdrop({ ...base, scrollY: 900 })).toBe(true);
  });
});

describe("iOS keeps the static sky (blank-launch guard)", () => {
  it("detects iPhone, iPad and iPadOS-as-Mac, not desktop Macs", async () => {
    const { isIosWebKit } = await import("./backdrop-policy");
    expect(
      isIosWebKit("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)", "iPhone", 5),
    ).toBe(true);
    expect(isIosWebKit("Mozilla/5.0 (iPad; CPU OS 18_0)", "iPad", 5)).toBe(
      true,
    );
    expect(
      isIosWebKit("Mozilla/5.0 (Macintosh; Intel Mac OS X)", "MacIntel", 5),
    ).toBe(true);
    expect(
      isIosWebKit("Mozilla/5.0 (Macintosh; Intel Mac OS X)", "MacIntel", 0),
    ).toBe(false);
    expect(
      isIosWebKit("Mozilla/5.0 (Linux; Android 14)", "Linux armv8l", 5),
    ).toBe(false);
  });

  it("never creates the WebGL layer on iOS", async () => {
    const { shouldAnimateBackdrop } = await import("./backdrop-policy");
    expect(shouldAnimateBackdrop({ reducedMotion: false, ios: true })).toBe(
      false,
    );
    expect(shouldAnimateBackdrop({ reducedMotion: false, ios: false })).toBe(
      true,
    );
  });
});

describe("backdropMode", () => {
  const desktop = { reducedMotion: false, deviceMemory: 8 };
  const iphone = { reducedMotion: false, ios: true };

  it("runs the Three.js scene where it is allowed", () => {
    expect(backdropMode(desktop)).toBe("webgl");
    expect(backdropMode({ reducedMotion: false })).toBe("webgl");
  });

  it("moves the sky in CSS only on iPhone and iPad, which never get WebGL", () => {
    expect(backdropMode(iphone)).toBe("css");
    expect(backdropMode({ ...iphone, deviceMemory: 4 })).toBe("css");
  });

  it("keeps the sky still when the person asked for less motion or less data", () => {
    expect(backdropMode({ ...iphone, reducedMotion: true })).toBe("static");
    expect(backdropMode({ ...iphone, saveData: true })).toBe("static");
    expect(backdropMode({ ...iphone, deviceMemory: 2 })).toBe("static");
    expect(backdropMode({ ...desktop, reducedMotion: true })).toBe("static");
    expect(backdropMode({ ...desktop, saveData: true })).toBe("static");
    expect(backdropMode({ ...desktop, deviceMemory: 1 })).toBe("static");
  });

  it("has one rule for whether the sky may move, shared by both layers", () => {
    for (const reducedMotion of [false, true]) {
      for (const saveData of [undefined, true]) {
        for (const deviceMemory of [undefined, 2, 4]) {
          for (const ios of [undefined, true]) {
            const h = { reducedMotion, saveData, deviceMemory, ios };
            // Anything that stops motion stops it on every layer; anything
            // else moves on exactly one of them.
            expect(backdropMode(h) !== "static", JSON.stringify(h)).toBe(
              motionAllowed(h),
            );
          }
        }
      }
    }
  });

  it("never runs both: WebGL and the CSS layer are exclusive, and agree with shouldAnimateBackdrop", () => {
    for (const reducedMotion of [false, true]) {
      for (const saveData of [undefined, false, true]) {
        for (const deviceMemory of [undefined, 1, 2, 4, 8]) {
          for (const ios of [undefined, false, true]) {
            const h = { reducedMotion, saveData, deviceMemory, ios };
            const mode = backdropMode(h);
            expect(mode === "webgl", JSON.stringify(h)).toBe(
              shouldAnimateBackdrop(h),
            );
            if (mode === "css") {
              expect(h.ios).toBe(true);
              expect(h.reducedMotion).toBe(false);
            }
            // Reduced motion is never moved, by either layer.
            if (reducedMotion) expect(mode).toBe("static");
          }
        }
      }
    }
  });
});
