import { describe, expect, it, vi } from "vitest";
import { getScenePalette, SCENE_TYPES } from "../palette";
import type { WeatherSceneType } from "../types";
import { seeded } from "./random";
import {
  BOUNDARY_MARGIN,
  buildCanvasScene,
  CLOUD_ALPHA,
  flashProfile,
  FOG_ALPHA,
  LIGHTNING_MAX_ALPHA,
  lightning,
  type Canvas2D,
  type CanvasScene,
  type Size,
} from "./scenes";

// These tests simulate minutes of animation frame by frame. They take a second
// or two on a laptop and several times that on a loaded CI runner, so they get
// more than the 5 s default instead of flaking at it.
vi.setConfig({ testTimeout: 30_000 });

const PHONE: Size = { w: 393, h: 640 };
const DT = 1 / 30;

function build(
  type: WeatherSceneType,
  seed = 1,
  isDay = true,
  size: Size = PHONE,
  windSpeed = 12,
): CanvasScene {
  return buildCanvasScene({
    type,
    size,
    palette: getScenePalette(type, isDay),
    isDay,
    windSpeed,
    rng: seeded(seed),
  });
}

/** A 2D context that records every call and every alpha, and nothing else. */
function recorder() {
  const calls: { op: string; args: number[]; alpha: number }[] = [];
  const styles = new Set<string>();
  const ctx: Canvas2D = {
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    clearRect: (...a) =>
      calls.push({ op: "clearRect", args: a, alpha: ctx.globalAlpha }),
    fillRect: (...a) => {
      styles.add(ctx.fillStyle);
      calls.push({ op: "fillRect", args: a, alpha: ctx.globalAlpha });
    },
    beginPath: () =>
      calls.push({ op: "beginPath", args: [], alpha: ctx.globalAlpha }),
    moveTo: (...a) =>
      calls.push({ op: "moveTo", args: a, alpha: ctx.globalAlpha }),
    lineTo: (...a) =>
      calls.push({ op: "lineTo", args: a, alpha: ctx.globalAlpha }),
    stroke: () => {
      styles.add(ctx.strokeStyle);
      calls.push({ op: "stroke", args: [], alpha: ctx.globalAlpha });
    },
    arc: (...a) => calls.push({ op: "arc", args: a, alpha: ctx.globalAlpha }),
    fill: () => {
      styles.add(ctx.fillStyle);
      calls.push({ op: "fill", args: [], alpha: ctx.globalAlpha });
    },
    drawImage: (_img, ...a) =>
      calls.push({ op: "drawImage", args: a, alpha: ctx.globalAlpha }),
  };
  return { ctx, calls, styles };
}

const sprites = () => ({});

describe("every scene", () => {
  for (const type of [...SCENE_TYPES, "not-a-scene" as WeatherSceneType]) {
    for (const isDay of [true, false]) {
      it(`${type} (${isDay ? "day" : "night"}) stays inside its boundary and keeps its particles`, () => {
        const scene = build(type, 11, isDay);
        const before = scene.points().length;
        expect(before).toBeGreaterThan(0);
        const slack = BOUNDARY_MARGIN + 0.2 * PHONE.h;
        for (let i = 0; i < 1500; i++) {
          scene.step(DT, (i + 1) * DT);
          if (i % 25 !== 0) continue;
          for (const p of scene.points()) {
            expect(
              Number.isFinite(p.x) && Number.isFinite(p.y),
              `${type} ${i}`,
            ).toBe(true);
            expect(p.x).toBeGreaterThanOrEqual(-(slack + p.pad));
            expect(p.x).toBeLessThanOrEqual(PHONE.w + slack + p.pad);
            expect(p.y).toBeGreaterThanOrEqual(-(slack + p.pad));
            expect(p.y).toBeLessThanOrEqual(PHONE.h + slack + p.pad);
          }
        }
        // Nothing is lost or added: particles are rerolled, never dropped.
        expect(scene.points()).toHaveLength(before);
      });

      it(`${type} (${isDay ? "day" : "night"}) draws only finite numbers, valid alphas and palette colours`, () => {
        const scene = build(type, 4, isDay);
        const palette = getScenePalette(
          type === ("not-a-scene" as WeatherSceneType) ? "partly-cloudy" : type,
          isDay,
        );
        const allowed = new Set(
          Object.values(palette).filter(
            (v): v is string => typeof v === "string",
          ),
        );
        const { ctx, calls, styles } = recorder();
        for (let i = 0; i < 120; i++) {
          scene.step(DT, (i + 1) * DT);
          scene.draw(ctx, sprites);
        }
        expect(calls.length).toBeGreaterThan(0);
        for (const c of calls) {
          expect(c.args.every(Number.isFinite), `${type} ${c.op}`).toBe(true);
          expect(c.alpha).toBeGreaterThanOrEqual(0);
          expect(c.alpha).toBeLessThanOrEqual(1);
        }
        for (const s of styles)
          expect(allowed.has(s), `${type} ${s}`).toBe(true);
      });
    }
  }
});

describe("the algorithm is random, not a loop", () => {
  /** Run a scene and collect where each particle reappears when it respawns (it jumps back up). */
  function respawns(type: WeatherSceneType, seed: number, steps: number) {
    const scene = build(type, seed);
    let prev = scene.points().map((p) => ({ ...p }));
    const events: { slot: number; x: number }[] = [];
    for (let i = 0; i < steps; i++) {
      scene.step(DT, (i + 1) * DT);
      const now = scene.points();
      now.forEach((p, slot) => {
        if (p.y < prev[slot].y - 100) events.push({ slot, x: p.x });
      });
      prev = now.map((p) => ({ ...p }));
    }
    return events;
  }

  for (const type of ["rain", "snow"] as const) {
    it(`${type}: every respawn lands somewhere new`, () => {
      const events = respawns(type, 8, 1800);
      expect(events.length).toBeGreaterThan(150);
      const xs = events.map((e) => e.x);
      // Every respawn x is its own number: a tile or a short cycle would repeat them.
      expect(new Set(xs).size).toBeGreaterThan(xs.length * 0.97);
      // And they cover the width, not one band.
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      const sd = Math.sqrt(
        xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length,
      );
      expect(sd).toBeGreaterThan(PHONE.w / 6);
      // One particle never comes back to the same place twice in a row.
      const bySlot = new Map<number, number[]>();
      for (const e of events)
        bySlot.set(e.slot, [...(bySlot.get(e.slot) ?? []), e.x]);
      for (const list of bySlot.values()) {
        if (list.length >= 3)
          expect(new Set(list.map(Math.round)).size).toBeGreaterThan(1);
      }
    });
  }

  it("a different seed is a different sky, the same seed the same sky", () => {
    const sample = (seed: number) => {
      const s = build("rain", seed);
      for (let i = 0; i < 200; i++) s.step(DT, (i + 1) * DT);
      return JSON.stringify(s.points());
    };
    expect(sample(1)).toBe(sample(1));
    expect(sample(1)).not.toBe(sample(2));
  });

  it("clouds come back as a different cloud: a new height and a new shape", () => {
    const scene = build("cloudy", 3);
    let prev = scene.points().map((p) => ({ ...p }));
    let events = 0;
    let newHeight = 0;
    let newSize = 0;
    for (let i = 0; i < 9000; i++) {
      scene.step(DT, (i + 1) * DT);
      const now = scene.points();
      now.forEach((p, slot) => {
        if (p.x < prev[slot].x - 100) {
          events++;
          if (Math.abs(p.y - prev[slot].y) > 1) newHeight++;
          if (Math.abs(p.pad - prev[slot].pad) > 0.5) newSize++;
        }
      });
      prev = now.map((p) => ({ ...p }));
    }
    expect(events).toBeGreaterThan(20);
    // Rerolled, not wrapped: almost every returning cloud differs from the one that left.
    expect(newHeight).toBeGreaterThan(events * 0.9);
    expect(newSize).toBeGreaterThan(events * 0.9);
  });
});

describe("the number of particles follows the box", () => {
  it("a bigger box has more, a smaller one fewer, within bounds", () => {
    const count = (size: Size) => build("rain", 1, true, size).points().length;
    const phone = count(PHONE);
    expect(count({ w: 820, h: 640 })).toBeGreaterThan(phone);
    expect(count({ w: 200, h: 300 })).toBeLessThan(phone);
    // Bounded: a huge box is not more than 2x, a tiny one at least a few.
    expect(count({ w: 3000, h: 3000 })).toBeLessThanOrEqual(phone * 2.2 + 8);
    expect(count({ w: 20, h: 20 })).toBeGreaterThanOrEqual(1);
  });
});

describe("lightning", () => {
  it("has a two-flash profile that is over in under half a second", () => {
    expect(flashProfile(-1)).toBe(0);
    expect(flashProfile(0)).toBe(1);
    expect(flashProfile(0.09)).toBeLessThan(0.5); // the dip between the flashes
    expect(flashProfile(0.15)).toBeGreaterThan(0.8); // the second flash
    expect(flashProfile(0.3)).toBeGreaterThan(0);
    expect(flashProfile(0.3)).toBeLessThan(0.9);
    expect(flashProfile(0.45)).toBe(0);
    expect(flashProfile(5)).toBe(0);
  });

  /** The lightning layer alone (no rain or clouds), so ten minutes cost nothing. */
  const strikeLayer = (seed: number) =>
    lightning({
      type: "thunderstorm",
      size: PHONE,
      palette: getScenePalette("thunderstorm", true),
      isDay: true,
      rng: seeded(seed),
    });

  it("strikes at random, 3 to 8 seconds apart, faint, never more than two flashes in a second", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const scene = strikeLayer(seed);
      const { ctx, calls } = recorder();
      const series: number[] = [];
      for (let i = 0; i < 30 * 600; i++) {
        const t = (i + 1) * DT;
        scene.step(DT, t);
        calls.length = 0;
        scene.draw(ctx, sprites);
        const fill = calls.find((c) => c.op === "fillRect");
        series.push(fill ? fill.alpha : 0);
      }
      expect(Math.max(...series)).toBeLessThanOrEqual(
        LIGHTNING_MAX_ALPHA + 1e-9,
      );
      expect(Math.max(...series)).toBeGreaterThan(LIGHTNING_MAX_ALPHA * 0.8);
      // Strike starts: the frame a flash rises from nothing.
      const starts: number[] = [];
      for (let i = 1; i < series.length; i++) {
        if (series[i] > 0 && series[i - 1] === 0) starts.push(i * DT);
      }
      expect(starts.length).toBeGreaterThan(50);
      expect(starts[0]).toBeGreaterThanOrEqual(1.9);
      expect(starts[0]).toBeLessThanOrEqual(5.2);
      const gaps = starts.slice(1).map((s, i) => s - starts[i]);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2.9);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(8.4);
      // Random, not a metronome.
      expect(new Set(gaps.map((g) => g.toFixed(1))).size).toBeGreaterThan(15);
      // WCAG 2.3.1: at most three flashes (peaks) in any one second; this scene has two.
      const peaks: number[] = [];
      for (let i = 1; i < series.length - 1; i++) {
        if (
          series[i] >= LIGHTNING_MAX_ALPHA * 0.5 &&
          series[i] > series[i - 1] &&
          series[i] >= series[i + 1]
        ) {
          peaks.push(i * DT);
        }
      }
      let worst = 0;
      for (let i = 0; i < peaks.length; i++) {
        const inSecond = peaks.filter(
          (p) => p >= peaks[i] && p < peaks[i] + 1,
        ).length;
        worst = Math.max(worst, inSecond);
      }
      expect(worst).toBeLessThanOrEqual(2);
    }
  });

  it("is part of the thunderstorm scene, under the same cap, and of no other", () => {
    const flashes = (type: WeatherSceneType) => {
      const scene = build(type, 2);
      const { ctx, calls } = recorder();
      const alphas: number[] = [];
      // Full-box fills only: a flash is the one fillRect over the whole box.
      for (let i = 0; i < 30 * 40; i++) {
        scene.step(DT, (i + 1) * DT);
        calls.length = 0;
        scene.draw(ctx, sprites);
        for (const c of calls) {
          if (
            c.op === "fillRect" &&
            c.args[2] === PHONE.w &&
            c.args[3] === PHONE.h
          ) {
            alphas.push(c.alpha);
          }
        }
      }
      return alphas;
    };
    const storm = flashes("thunderstorm");
    expect(storm.length).toBeGreaterThan(0);
    expect(Math.max(...storm)).toBeLessThanOrEqual(LIGHTNING_MAX_ALPHA + 1e-9);
    expect(flashes("rain")).toHaveLength(0);
    expect(flashes("clear")).toHaveLength(0);
  });
});

describe("clouds are faint enough to read text over", () => {
  it("never draw a puff brighter than the cloud budget", () => {
    const scene = build("cloudy", 2);
    const { ctx, calls } = recorder();
    for (let i = 0; i < 90; i++) {
      scene.step(DT, (i + 1) * DT);
      scene.draw(ctx, sprites);
    }
    const alphas = calls
      .filter((c) => c.op === "drawImage")
      .map((c) => c.alpha);
    expect(alphas.length).toBeGreaterThan(0);
    // An absolute budget, not the constant itself: white text over a cloud
    // puff loses contrast, so a puff may never be brighter than this.
    expect(Math.max(...alphas)).toBeLessThanOrEqual(0.14);
    expect(CLOUD_ALPHA).toBeLessThanOrEqual(0.16);
  });
});

describe("fog and haze are faint enough to read text over", () => {
  it("never draw a band brighter than the fog budget, however long it runs", () => {
    for (const type of ["fog", "haze"] as const) {
      const scene = build(type, 3);
      const { ctx, calls } = recorder();
      const alphas: number[] = [];
      for (let i = 0; i < 30 * 120; i++) {
        scene.step(DT, (i + 1) * DT);
        calls.length = 0;
        scene.draw(ctx, sprites);
        alphas.push(
          ...calls.filter((c) => c.op === "drawImage").map((c) => c.alpha),
        );
      }
      expect(alphas.length).toBeGreaterThan(0);
      // An absolute budget, not the constant itself: overlapping white bands
      // under white text lose contrast, so none may be brighter than this.
      expect(Math.max(...alphas), type).toBeLessThanOrEqual(0.12);
    }
    expect(FOG_ALPHA.max).toBeLessThanOrEqual(0.12);
  });
});
