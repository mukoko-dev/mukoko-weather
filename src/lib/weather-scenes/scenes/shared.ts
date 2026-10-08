import { SPRITE_MASK } from "../palette";

/**
 * Shared Three.js helpers for the scene builders. No colours live here —
 * every colour comes from palette.ts via the caller.
 */

type Three = typeof import("three");

/**
 * A soft, round particle sprite (radial alpha falloff) so clouds, fog wisps,
 * snowflakes and stars render as soft discs instead of hard squares. Built on
 * a 64px canvas; returns null when there is no DOM (SSR / tests), in which
 * case the material simply falls back to square points.
 */
export function softSprite(THREE: Three) {
  if (typeof document === "undefined") return null;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const g = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  g.addColorStop(0, SPRITE_MASK.core);
  g.addColorStop(0.45, SPRITE_MASK.mid);
  g.addColorStop(1, SPRITE_MASK.edge);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

/** PointsMaterial using the soft sprite when available. */
export function softPointsMaterial(
  THREE: Three,
  sprite: ReturnType<typeof softSprite>,
  opts: { color: string; size: number; opacity: number },
) {
  return new THREE.PointsMaterial({
    color: opts.color,
    size: opts.size,
    transparent: true,
    opacity: opts.opacity,
    depthWrite: false,
    ...(sprite ? { map: sprite, alphaTest: 0.01 } : {}),
  });
}

/**
 * Rain as short slanted streaks (LineSegments) rather than dots — two
 * vertices per drop. `step()` advances every drop; drops that fall below the
 * floor respawn at the top.
 */
export function rainStreaks(
  THREE: Three,
  opts: {
    count: number;
    spreadX: number;
    spreadZ: number;
    length: number;
    slant: number;
    minSpeed: number;
    maxSpeed: number;
    color: string;
    opacity: number;
  },
) {
  const { count, spreadX, spreadZ, length, slant } = opts;
  const pos = new Float32Array(count * 6);
  const vel = new Float32Array(count);
  const place = (i: number, y: number) => {
    const x = (Math.random() - 0.5) * spreadX;
    const z = (Math.random() - 0.5) * spreadZ;
    pos[i * 6] = x;
    pos[i * 6 + 1] = y;
    pos[i * 6 + 2] = z;
    pos[i * 6 + 3] = x - slant * length;
    pos[i * 6 + 4] = y + length;
    pos[i * 6 + 5] = z;
  };
  for (let i = 0; i < count; i++) {
    place(i, Math.random() * 30 - 8);
    vel[i] = opts.minSpeed + Math.random() * (opts.maxSpeed - opts.minSpeed);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.LineBasicMaterial({
    color: opts.color,
    transparent: true,
    opacity: opts.opacity,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geo, mat);
  const attr = geo.attributes.position as InstanceType<
    typeof THREE.BufferAttribute
  >;

  return {
    object: lines,
    geometry: geo,
    material: mat,
    step(drift: number) {
      const a = attr.array as Float32Array;
      for (let i = 0; i < count; i++) {
        const dy = vel[i];
        const dx = drift + slant * dy;
        a[i * 6] += dx;
        a[i * 6 + 3] += dx;
        a[i * 6 + 1] -= dy;
        a[i * 6 + 4] -= dy;
        if (a[i * 6 + 1] < -10) place(i, 20);
      }
      attr.needsUpdate = true;
    },
  };
}

/** Random positions in a box, as a flat xyz Float32Array. */
export function scatter(
  count: number,
  x: [number, number],
  y: [number, number],
  z: [number, number],
): Float32Array {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    out[i * 3] = x[0] + Math.random() * (x[1] - x[0]);
    out[i * 3 + 1] = y[0] + Math.random() * (y[1] - y[0]);
    out[i * 3 + 2] = z[0] + Math.random() * (z[1] - z[0]);
  }
  return out;
}

/**
 * A soft radial halo (one large sprite point) — the sun's or moon's glow,
 * fading smoothly instead of a hard ring.
 */
export function softGlow(
  THREE: Three,
  sprite: ReturnType<typeof softSprite>,
  opts: {
    color: string;
    size: number;
    opacity: number;
    position: { x: number; y: number; z: number };
  },
) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([opts.position.x, opts.position.y, opts.position.z]),
      3,
    ),
  );
  const mat = softPointsMaterial(THREE, sprite, opts);
  return { object: new THREE.Points(geo, mat), geometry: geo, material: mat };
}
