/**
 * Test fixtures for the capacity probe (#542): the tiles Worker's answers as
 * tests need them. Not imported by the app.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import type { ProbeResponse } from "./map-capacity";

/** The Worker's 68-byte placeholder, parsed out of weather-core's source. */
export function workerPlaceholder(): Uint8Array {
  const source = readFileSync(
    resolve(__dirname, "../../workers/crates/weather-core/src/tiles.rs"),
    "utf-8",
  );
  const decl = source.slice(source.indexOf("pub const TRANSPARENT_PNG"));
  const body = decl.slice(decl.indexOf("= [") + 3, decl.indexOf("];"));
  const bytes = [
    ...body.replace(/\/\/.*$/gm, "").matchAll(/0x([0-9A-Fa-f]{2})/g),
  ];
  return Uint8Array.from(bytes.map((m) => parseInt(m[1], 16)));
}

/** A PNG header for a `width` x `height` picture (enough for the size check). */
export function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

export function probeResponse(
  init: {
    status?: number;
    headers?: Record<string, string>;
    body?: Uint8Array;
  } = {},
): ProbeResponse {
  const status = init.status ?? 200;
  const headers = new Map(
    Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    arrayBuffer: async () => {
      const body = init.body ?? pngHeader(256, 256);
      return body.buffer.slice(
        body.byteOffset,
        body.byteOffset + body.byteLength,
      ) as ArrayBuffer;
    },
  };
}

/** The Worker's blank placeholder: 200, `X-Map-Tile: empty`, a 1x1 PNG. */
export const BLANK = (): ProbeResponse =>
  probeResponse({
    headers: { "X-Map-Tile": "empty" },
    body: workerPlaceholder(),
  });
/** A real tile: 200, a 256 px PNG, no placeholder header. */
export const REAL = (): ProbeResponse =>
  probeResponse({
    headers: { "X-Cache": "HIT", "X-Map-Layer": "temperature" },
  });
