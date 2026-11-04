/**
 * The browser end of a field raster for a picture that is not a MapLibre map
 * (#476): the raster painted on an offscreen canvas and read back as a PNG
 * data URL, which an SVG `<image>` can show. The pure part (the raster, its
 * palette order, `paintRaster`) is field-raster.ts; MapLibreMap hands the same
 * pixels to MapLibre as an ImageData instead.
 *
 * Dependency-free: no map library, no Chart.js; colours are read from the
 * `--wx-*` tokens in globals.css, so nothing here hard-codes a colour.
 */

import {
  paintRaster,
  parseCssColor,
  type FieldRaster,
  type Rgb,
} from "./field-raster";

/** A band whose token cannot be read is drawn neutral grey, never left out. */
const NEUTRAL: Rgb = [128, 128, 128];

/**
 * One colour per band, read from the tokens NOW (not at module load), so a
 * light/dark switch repaints in the new theme's colours. Neutral grey for a
 * token the page does not define or a colour the parser does not read.
 */
export function rasterPalette(raster: FieldRaster): Rgb[] {
  if (typeof document === "undefined") return raster.tokens.map(() => NEUTRAL);
  const style = getComputedStyle(document.documentElement);
  return raster.tokens.map(
    (token) => parseCssColor(style.getPropertyValue(token)) ?? NEUTRAL,
  );
}

/**
 * The raster as a PNG data URL, or null where there is no canvas to paint on
 * (the server, a browser without a 2D context, a canvas that refuses to be read).
 * The canvas is not attached and its backing store is released at once, so
 * nothing is kept but the string (a few kilobytes at 96 x 96).
 */
export function rasterDataUrl(
  raster: FieldRaster,
  palette: readonly Rgb[],
): string | null {
  if (typeof document === "undefined") return null;
  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = document.createElement("canvas");
    canvas.width = raster.width;
    canvas.height = raster.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const image = ctx.createImageData(raster.width, raster.height);
    image.data.set(paintRaster(raster, palette));
    ctx.putImageData(image, 0, 0);
    const url = canvas.toDataURL("image/png");
    return url.startsWith("data:image/png") ? url : null;
  } catch {
    return null;
  } finally {
    if (canvas) canvas.width = canvas.height = 0;
  }
}
