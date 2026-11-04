/**
 * The 2D weather effects: one per weather scene, for the devices that never get
 * the Three.js scene (iPhone and iPad, see `backdropMode`). Pure: no DOM, no
 * clock, no canvas. A scene is state that `step(dt, t)` moves and a `draw` that
 * paints it through the small `Canvas2D` interface, so the tests run the real
 * algorithm and record what it draws.
 *
 * **Random, never a loop.** Every particle has a random position, size, speed
 * and opacity, placed with a best-candidate sample so it is even but irregular
 * (`random.ts`), and every particle that leaves the region is REROLLED, not
 * wrapped: a drop that falls out of the bottom comes back at the top with a new
 * x, depth, length and speed; a cloud that drifts out of the right comes back at
 * the left with a new height, size and shape. Lightning is a random 3 to 8
 * seconds apart. Nothing is a tile.
 *
 * **A boundary around every effect.** The effects live in a `Size` box (the
 * hero region). A particle that leaves it past `BOUNDARY_MARGIN` is rerolled
 * back inside, so the population never drifts away and nothing outside the box
 * is ever drawn (the caller also clips to the box). `points()` reports every
 * particle's position for the tests that check this.
 *
 * **Colour** is the scene palette (`palette.ts`): the colour each weather
 * really is, the same as the 3D scenes. Alpha is set with `globalAlpha`, never
 * by building colour strings.
 */

import type { ScenePalette, SkyPhase } from "../palette";
import type { WeatherSceneType } from "../types";
import { between, bestCandidate, clamp, type Rng } from "./random";

export interface Size {
  w: number;
  h: number;
}

/** The slice of the 2D context the effects use (tests record the calls). */
export interface Canvas2D {
  globalAlpha: number;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineCap: string;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  fill(): void;
  drawImage(img: object, dx: number, dy: number, dw: number, dh: number): void;
}

/** A soft round sprite tinted with a colour, made once per colour by the caller. */
export type SpriteSource = (color: string) => object;

export interface SceneInit {
  type: WeatherSceneType;
  size: Size;
  palette: ScenePalette;
  isDay: boolean;
  phase?: SkyPhase;
  windSpeed?: number;
  rng: Rng;
}

export interface CanvasScene {
  /** Move everything `dt` seconds on; `t` is the scene's total elapsed time. */
  step(dt: number, t: number): void;
  draw(ctx: Canvas2D, sprites: SpriteSource): void;
  /** Where every particle is, and how far it reaches (for the boundary tests). */
  points(): readonly { x: number; y: number; pad: number }[];
}

/** How far past the box a particle may go before it is rerolled back inside. */
export const BOUNDARY_MARGIN = 40;

/** The most a lightning flash lifts the sky, as `globalAlpha`. */
export const LIGHTNING_MAX_ALPHA = 0.12;

/**
 * Clouds are drawn very faintly. The hero's text is white on the sky, and a
 * white cloud puff under it lowers the contrast: at 20% white over the lightest
 * sky the text falls below 4.5:1. A cloud puff's alpha is its own random
 * 0.45..0.85, times its layer's strength, times this.
 */
export const CLOUD_ALPHA = 0.16;

/**
 * A fog or haze band's own random alpha. Several wide bands overlap, so the
 * text under them is lightened more than under one cloud puff; this keeps white
 * text above 4.5:1 on the lightest fog sky (measured in Chromium).
 */
export const FOG_ALPHA = { min: 0.05, max: 0.12 } as const;

const TAU = Math.PI * 2;
/** The box the counts are written for: an iPhone's hero region. */
const REF_AREA = 393 * 640;

/** How much bigger or smaller than the phone box this box is, bounded. */
function areaFactor(size: Size): number {
  return clamp((size.w * size.h) / REF_AREA, 0.4, 2);
}

function countFor(base: number, size: Size): number {
  return Math.max(1, Math.round(base * areaFactor(size)));
}

// --- Rain ------------------------------------------------------------------

interface Drop {
  x: number;
  y: number;
  len: number;
  speed: number;
  bucket: 0 | 1 | 2;
}

/** A drop's random look: far drops are short, slow, thin and faint. */
function rollDrop(rng: Rng, d: Drop, speedMul: number): void {
  const depth = rng() ** 1.5;
  d.len = 8 + 18 * depth;
  d.speed = (320 + 380 * depth) * speedMul;
  d.bucket = depth < 0.34 ? 0 : depth < 0.67 ? 1 : 2;
}

function rain(
  init: SceneInit,
  opts: { density: number; speed: number; slant: number },
): CanvasScene {
  const { size, rng, palette } = init;
  const slant = clamp(opts.slant + (init.windSpeed ?? 10) / 400, 0.05, 0.45);
  const spawnWidth = size.w + slant * size.h;
  const n = countFor(opts.density, size);
  const drops: Drop[] = bestCandidate(n, spawnWidth, size.h, rng).map((p) => {
    const d: Drop = { x: p.x, y: p.y, len: 0, speed: 0, bucket: 0 };
    rollDrop(rng, d, opts.speed);
    return d;
  });
  return {
    step(dt) {
      for (const d of drops) {
        d.y += d.speed * dt;
        d.x -= d.speed * dt * slant;
        if (d.y - d.len > size.h || d.x < -BOUNDARY_MARGIN * 2) {
          // Out of the bottom (or the side): back in at the top, new in every way.
          rollDrop(rng, d, opts.speed);
          d.x = rng() * spawnWidth;
          d.y = -d.len - rng() * size.h * 0.15;
        }
      }
    },
    draw(ctx) {
      ctx.strokeStyle = palette.particle;
      ctx.lineCap = "round";
      for (const bucket of [0, 1, 2] as const) {
        ctx.lineWidth = 0.7 + 0.55 * bucket;
        ctx.globalAlpha = 0.2 + 0.2 * bucket;
        ctx.beginPath();
        for (const d of drops) {
          if (d.bucket !== bucket) continue;
          ctx.moveTo(d.x, d.y);
          ctx.lineTo(d.x - d.len * slant, d.y + d.len);
        }
        ctx.stroke();
      }
    },
    points: () => drops.map((d) => ({ x: d.x, y: d.y, pad: d.len })),
  };
}

// --- Lightning ---------------------------------------------------------------

/**
 * The brightness of a strike `since` seconds after it began: a sharp flash, a
 * dip, a second flash, then a fast fade, over about 0.45 s. Two flashes within
 * 0.2 s, strikes seconds apart: never more than two flashes in a second
 * (WCAG 2.3.1).
 */
export function flashProfile(since: number): number {
  if (since < 0) return 0;
  if (since < 0.06) return 1;
  if (since < 0.12) return 0.35;
  if (since < 0.18) return 0.9;
  if (since < 0.45) return 0.9 * (1 - (since - 0.18) / 0.27);
  return 0;
}

/** The strikes: the first 2 to 5 s in, then a random 3 to 8 s apart. */
function lightning(init: SceneInit): CanvasScene & { flash(): number } {
  const { size, rng, palette } = init;
  let nextAt = between(rng, 2, 5);
  let strikeAt = -1;
  let flash = 0;
  return {
    step(_dt, t) {
      if (t >= nextAt) {
        strikeAt = t;
        nextAt = t + between(rng, 3, 8);
      }
      flash = strikeAt < 0 ? 0 : flashProfile(t - strikeAt);
    },
    draw(ctx) {
      if (flash <= 0) return;
      ctx.fillStyle = palette.flash ?? palette.particle;
      ctx.globalAlpha = LIGHTNING_MAX_ALPHA * flash;
      ctx.fillRect(0, 0, size.w, size.h);
    },
    points: () => [],
    flash: () => flash,
  };
}

// --- Clouds ------------------------------------------------------------------

interface Puff {
  dx: number;
  dy: number;
  r: number;
}

interface Cloud {
  x: number;
  y: number;
  speed: number;
  alpha: number;
  extent: number;
  puffs: Puff[];
}

/** A cloud's random shape: a row of overlapping puffs of random radius. */
function rollCloud(rng: Rng, c: Cloud, size: number[], speed: number[]): void {
  const scale = between(rng, size[0], size[1]);
  const n = 4 + Math.floor(rng() * 4);
  c.puffs = [];
  c.extent = 0;
  for (let i = 0; i < n; i++) {
    const dx =
      (i / (n - 1) - 0.5) * 150 * scale + between(rng, -14, 14) * scale;
    const dy = between(rng, -14, 10) * scale;
    const r = between(rng, 30, 52) * scale;
    c.puffs.push({ dx, dy, r });
    c.extent = Math.max(c.extent, Math.abs(dx) + r);
  }
  c.speed = between(rng, speed[0], speed[1]);
  c.alpha = between(rng, 0.45, 0.85);
}

function clouds(
  init: SceneInit,
  opts: {
    count: number;
    size: [number, number];
    speed: [number, number];
    /** Where the cloud deck sits, as fractions of the box height. */
    band: [number, number];
    strength: number;
  },
): CanvasScene {
  const { size, rng, palette } = init;
  const n = countFor(opts.count, size);
  const band = size.h * (opts.band[1] - opts.band[0]);
  const spots = bestCandidate(n, size.w, band, rng);
  const list: Cloud[] = spots.map((p) => {
    const c: Cloud = {
      x: p.x,
      y: size.h * opts.band[0] + p.y,
      speed: 0,
      alpha: 0,
      extent: 0,
      puffs: [],
    };
    rollCloud(rng, c, opts.size, opts.speed);
    return c;
  });
  return {
    step(dt) {
      for (const c of list) {
        c.x += c.speed * dt;
        if (c.x - c.extent > size.w + BOUNDARY_MARGIN) {
          // Out of the right: back in at the left, a different cloud at a different height.
          rollCloud(rng, c, opts.size, opts.speed);
          c.x = -c.extent - rng() * BOUNDARY_MARGIN;
          c.y = size.h * (opts.band[0] + rng() * (opts.band[1] - opts.band[0]));
        }
      }
    },
    draw(ctx, sprites) {
      // Undersides first, then the lit tops over them.
      for (const pass of [0, 1] as const) {
        const img = sprites(pass === 0 ? palette.cloudShade : palette.cloud);
        for (const c of list) {
          ctx.globalAlpha =
            c.alpha * opts.strength * CLOUD_ALPHA * (pass === 0 ? 0.8 : 1);
          for (const p of c.puffs) {
            const y = c.y + p.dy + (pass === 0 ? p.r * 0.25 : 0);
            ctx.drawImage(img, c.x + p.dx - p.r, y - p.r, p.r * 2, p.r * 2);
          }
        }
      }
    },
    points: () => list.map((c) => ({ x: c.x, y: c.y, pad: c.extent })),
  };
}

// --- Sun, moon, stars, motes -------------------------------------------------

/** The sun by day and the moon by night: a soft glow and a small disc. */
function bodyGlow(init: SceneInit): CanvasScene {
  const { size, rng, palette } = init;
  const cx = size.w * between(rng, 0.6, 0.85);
  const cy = size.h * between(rng, 0.1, 0.2);
  const radius = between(rng, 80, 110) * clamp(areaFactor(size), 0.8, 1.4);
  const phase = rng() * TAU;
  let t = 0;
  return {
    step(_dt, now) {
      t = now;
    },
    draw(ctx, sprites) {
      ctx.globalAlpha = 0.5 + 0.12 * Math.sin(t * 0.5 + phase);
      ctx.drawImage(
        sprites(palette.glow),
        cx - radius,
        cy - radius,
        radius * 2,
        radius * 2,
      );
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = palette.body;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.14, 0, TAU);
      ctx.fill();
    },
    points: () => [{ x: cx, y: cy, pad: radius }],
  };
}

interface Star {
  x: number;
  y: number;
  r: number;
  base: number;
  period: number;
  phase: number;
}

/** Stars: placed once, evenly and irregularly; each twinkles on its own beat. */
function stars(init: SceneInit, density: number): CanvasScene {
  const { size, rng, palette } = init;
  const n = countFor(density, size);
  const list: Star[] = bestCandidate(n, size.w, size.h * 0.75, rng).map(
    (p) => ({
      x: p.x,
      y: p.y,
      r: between(rng, 0.5, 1.6),
      base: between(rng, 0.4, 0.9),
      period: between(rng, 2.5, 6),
      phase: rng() * TAU,
    }),
  );
  let t = 0;
  return {
    step(_dt, now) {
      t = now;
    },
    draw(ctx) {
      ctx.fillStyle = palette.particle;
      for (const s of list) {
        ctx.globalAlpha =
          s.base * (0.55 + 0.45 * Math.sin((t * TAU) / s.period + s.phase));
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, TAU);
        ctx.fill();
      }
    },
    points: () => list.map((s) => ({ x: s.x, y: s.y, pad: s.r })),
  };
}

interface Mote {
  x: number;
  y: number;
  r: number;
  vy: number;
  amp: number;
  freq: number;
  phase: number;
  baseX: number;
}

/** Specks of light or dust drifting up, each swaying and twinkling at random. */
function motes(init: SceneInit, density: number): CanvasScene {
  const { size, rng, palette } = init;
  const n = countFor(density, size);
  const roll = (m: Mote) => {
    m.r = between(rng, 0.8, 2);
    m.vy = -between(rng, 4, 12);
    m.amp = between(rng, 4, 14);
    m.freq = between(rng, 0.4, 1.2);
    m.phase = rng() * TAU;
  };
  const list: Mote[] = bestCandidate(n, size.w, size.h, rng).map((p) => {
    const m: Mote = {
      x: p.x,
      y: p.y,
      r: 0,
      vy: 0,
      amp: 0,
      freq: 0,
      phase: 0,
      baseX: p.x,
    };
    roll(m);
    return m;
  });
  let t = 0;
  return {
    step(dt, now) {
      t = now;
      for (const m of list) {
        m.y += m.vy * dt;
        m.x = m.baseX + m.amp * Math.sin(m.freq * now + m.phase);
        if (m.y < -BOUNDARY_MARGIN) {
          roll(m);
          m.baseX = rng() * size.w;
          m.y = size.h + rng() * BOUNDARY_MARGIN;
        }
      }
    },
    draw(ctx) {
      ctx.fillStyle = palette.particle;
      for (const m of list) {
        ctx.globalAlpha = 0.25 + 0.25 * Math.sin(t * 1.3 + m.phase);
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.r, 0, TAU);
        ctx.fill();
      }
    },
    points: () => list.map((m) => ({ x: m.x, y: m.y, pad: m.r + m.amp })),
  };
}

// --- Snow ------------------------------------------------------------------

interface Flake {
  baseX: number;
  y: number;
  r: number;
  speed: number;
  amp: number;
  freq: number;
  phase: number;
  alpha: number;
  x: number;
}

function snow(init: SceneInit, density: number): CanvasScene {
  const { size, rng, palette } = init;
  const n = countFor(density, size);
  const drift = clamp((init.windSpeed ?? 8) / 8, 0, 6);
  const roll = (f: Flake) => {
    const depth = rng();
    f.r = 1.2 + 2.2 * depth;
    f.speed = 22 + 48 * depth;
    f.amp = between(rng, 6, 22);
    f.freq = between(rng, 0.6, 1.6);
    f.phase = rng() * TAU;
    f.alpha = 0.45 + 0.5 * depth;
  };
  const list: Flake[] = bestCandidate(n, size.w, size.h, rng).map((p) => {
    const f: Flake = {
      baseX: p.x,
      y: p.y,
      r: 0,
      speed: 0,
      amp: 0,
      freq: 0,
      phase: 0,
      alpha: 0,
      x: p.x,
    };
    roll(f);
    return f;
  });
  return {
    step(dt, t) {
      for (const f of list) {
        f.y += f.speed * dt;
        f.baseX -= drift * dt;
        f.x = f.baseX + f.amp * Math.sin(f.freq * t + f.phase);
        if (f.y - f.r > size.h || f.baseX < -BOUNDARY_MARGIN - f.amp) {
          roll(f);
          f.baseX = rng() * (size.w + 60);
          f.y = -f.r - rng() * size.h * 0.15;
        }
      }
    },
    draw(ctx) {
      ctx.fillStyle = palette.particle;
      for (const f of list) {
        ctx.globalAlpha = f.alpha;
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, TAU);
        ctx.fill();
      }
    },
    points: () => list.map((f) => ({ x: f.x, y: f.y, pad: f.r + f.amp })),
  };
}

// --- Fog and haze --------------------------------------------------------------

interface Band {
  x: number;
  y: number;
  bw: number;
  bh: number;
  speed: number;
  alpha: number;
  period: number;
  phase: number;
}

/** Wide soft bands drifting either way at their own speed, breathing slowly. */
function fogBands(init: SceneInit, count: number): CanvasScene {
  const { size, rng, palette } = init;
  const roll = (b: Band) => {
    b.bw = between(rng, size.w * 1.2, size.w * 2.2);
    b.bh = between(rng, 60, 130);
    b.speed = (rng() < 0.5 ? -1 : 1) * between(rng, 5, 14);
    b.alpha = between(rng, FOG_ALPHA.min, FOG_ALPHA.max);
    b.period = between(rng, 6, 14);
    b.phase = rng() * TAU;
    b.y = size.h * between(rng, 0.05, 0.95);
  };
  const list: Band[] = bestCandidate(
    countFor(count, size),
    size.w,
    size.h,
    rng,
  ).map((p) => {
    const b: Band = {
      x: p.x,
      y: p.y,
      bw: 0,
      bh: 0,
      speed: 0,
      alpha: 0,
      period: 1,
      phase: 0,
    };
    roll(b);
    b.y = p.y;
    return b;
  });
  let t = 0;
  return {
    step(dt, now) {
      t = now;
      for (const b of list) {
        b.x += b.speed * dt;
        const gone =
          b.speed > 0
            ? b.x - b.bw / 2 > size.w + BOUNDARY_MARGIN
            : b.x + b.bw / 2 < -BOUNDARY_MARGIN;
        if (gone) {
          roll(b);
          // Back in from the side it will drift away from.
          b.x =
            b.speed > 0
              ? -b.bw / 2 - rng() * BOUNDARY_MARGIN
              : size.w + b.bw / 2 + rng() * BOUNDARY_MARGIN;
        }
      }
    },
    draw(ctx, sprites) {
      const img = sprites(palette.particle);
      for (const b of list) {
        ctx.globalAlpha =
          b.alpha * (0.75 + 0.25 * Math.sin((t * TAU) / b.period + b.phase));
        ctx.drawImage(img, b.x - b.bw / 2, b.y - b.bh / 2, b.bw, b.bh);
      }
    },
    points: () => list.map((b) => ({ x: b.x, y: b.y, pad: b.bw / 2 })),
  };
}

// --- Wind ------------------------------------------------------------------

interface Streak {
  x: number;
  y: number;
  len: number;
  speed: number;
  alpha: number;
}

function windStreaks(init: SceneInit, density: number): CanvasScene {
  const { size, rng, palette } = init;
  const roll = (s: Streak) => {
    s.len = between(rng, 40, 120);
    s.speed = between(rng, 300, 700);
    s.alpha = between(rng, 0.1, 0.4);
  };
  const list: Streak[] = bestCandidate(
    countFor(density, size),
    size.w,
    size.h,
    rng,
  ).map((p) => {
    const s: Streak = { x: p.x, y: p.y, len: 0, speed: 0, alpha: 0 };
    roll(s);
    return s;
  });
  return {
    step(dt) {
      for (const s of list) {
        s.x += s.speed * dt;
        s.y -= s.speed * dt * 0.04;
        if (s.x - s.len > size.w + BOUNDARY_MARGIN || s.y < -BOUNDARY_MARGIN) {
          roll(s);
          s.x = -s.len - rng() * size.w * 0.3;
          s.y = rng() * size.h;
        }
      }
    },
    draw(ctx) {
      ctx.strokeStyle = palette.particle;
      ctx.lineCap = "round";
      ctx.lineWidth = 1.1;
      for (const s of list) {
        ctx.globalAlpha = s.alpha;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x - s.len, s.y + s.len * 0.04);
        ctx.stroke();
      }
    },
    points: () => list.map((s) => ({ x: s.x, y: s.y, pad: s.len })),
  };
}

// --- The scenes ------------------------------------------------------------------

/** Run several layers as one scene, back to front. */
function compose(...layers: CanvasScene[]): CanvasScene {
  return {
    step(dt, t) {
      for (const l of layers) l.step(dt, t);
    },
    draw(ctx, sprites) {
      for (const l of layers) l.draw(ctx, sprites);
    },
    points: () => layers.flatMap((l) => l.points()),
  };
}

/** The effect for a weather scene, in the box `init.size`. */
export function buildCanvasScene(init: SceneInit): CanvasScene {
  switch (init.type) {
    case "clear":
      return compose(
        bodyGlow(init),
        init.isDay ? motes(init, 30) : stars(init, 70),
      );
    case "partly-cloudy":
      return compose(
        bodyGlow(init),
        init.isDay ? motes(init, 12) : stars(init, 40),
        clouds(init, {
          count: 4,
          size: [0.8, 1.5],
          speed: [6, 14],
          band: [0.05, 0.6],
          strength: 0.8,
        }),
      );
    case "cloudy":
      return clouds(init, {
        count: 9,
        size: [1, 1.8],
        speed: [5, 12],
        band: [0.0, 0.7],
        strength: 1,
      });
    case "rain":
      return compose(
        clouds(init, {
          count: 5,
          size: [1.1, 1.8],
          speed: [4, 10],
          band: [0.0, 0.35],
          strength: 0.9,
        }),
        rain(init, { density: 150, speed: 1, slant: 0.14 }),
      );
    case "thunderstorm":
      return compose(
        clouds(init, {
          count: 6,
          size: [1.2, 2],
          speed: [5, 12],
          band: [0.0, 0.35],
          strength: 1,
        }),
        rain(init, { density: 220, speed: 1.25, slant: 0.2 }),
        lightning(init),
      );
    case "snow":
      return compose(
        clouds(init, {
          count: 3,
          size: [1.2, 1.9],
          speed: [3, 8],
          band: [0.0, 0.3],
          strength: 0.7,
        }),
        snow(init, 80),
      );
    case "fog":
      return fogBands(init, 8);
    case "haze":
      return compose(fogBands(init, 7), motes(init, 24));
    case "windy":
      return compose(
        clouds(init, {
          count: 3,
          size: [1, 1.6],
          speed: [40, 90],
          band: [0.05, 0.5],
          strength: 0.7,
        }),
        windStreaks(init, 26),
      );
    default:
      return buildCanvasScene({ ...init, type: "partly-cloudy" });
  }
}
