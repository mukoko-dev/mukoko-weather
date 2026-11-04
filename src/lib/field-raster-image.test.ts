/**
 * The browser end of a field raster (#476): the data URL an SVG <image> shows.
 * Vitest runs in Node, so the document and its canvas are small fakes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { rasterDataUrl, rasterPalette } from "./field-raster-image";
import { NO_BAND, type FieldRaster } from "./field-raster";

/** A 3 x 2 raster: band 0, band 1, a hole; the second row all band 1, one half faded. */
function raster(): FieldRaster {
  return {
    width: 3,
    height: 2,
    bands: Int8Array.from([0, 1, NO_BAND, 1, 1, 1]),
    alpha: Uint8ClampedArray.from([255, 255, 255, 128, 255, 255]),
    values: new Float32Array(6),
    tokens: ["--wx-aqi-1", "--wx-aqi-2"],
    levels: [],
    corners: [
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ],
    extent: { west: 0, east: 1, south: 0, north: 1 },
  };
}

interface FakeCanvas {
  width: number;
  height: number;
  getContext: ReturnType<typeof vi.fn>;
  toDataURL: ReturnType<typeof vi.fn>;
}

function stubDocument(
  opts: {
    context?: boolean;
    toDataURL?: () => string;
    styles?: Record<string, string>;
  } = {},
) {
  const put = vi.fn();
  const canvases: FakeCanvas[] = [];
  /** The canvas size at the moment it is read. */
  const readAt: [number, number][] = [];
  const canvasFactory = (): FakeCanvas => {
    const canvas: FakeCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() =>
        opts.context === false
          ? null
          : {
              createImageData: (w: number, h: number) => ({
                data: new Uint8ClampedArray(w * h * 4),
              }),
              putImageData: put,
            },
      ),
      toDataURL: vi.fn(function (this: FakeCanvas) {
        readAt.push([this.width, this.height]);
        return (opts.toDataURL ?? (() => "data:image/png;base64,AAAA"))();
      }),
    };
    canvases.push(canvas);
    return canvas;
  };
  vi.stubGlobal("document", {
    createElement: canvasFactory,
    documentElement: {},
  });
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: (name: string) => opts.styles?.[name] ?? "",
  }));
  return { put, canvases, readAt };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rasterDataUrl", () => {
  const palette = [
    [0, 228, 0],
    [255, 255, 0],
  ] as const;

  it("paints the raster's pixels (band colour, edge fade as alpha, holes clear) and returns a PNG data URL", () => {
    const { put, canvases } = stubDocument();
    expect(rasterDataUrl(raster(), palette)).toBe("data:image/png;base64,AAAA");
    expect(canvases).toHaveLength(1);
    const [image, x, y] = put.mock.calls[0];
    expect(x).toBe(0);
    expect(y).toBe(0);
    expect(Array.from(image.data as Uint8ClampedArray)).toEqual([
      0,
      228,
      0,
      255, // band 0, opaque
      255,
      255,
      0,
      255, // band 1
      0,
      0,
      0,
      0, // a hole: fully transparent
      255,
      255,
      0,
      128, // band 1, faded
      255,
      255,
      0,
      255,
      255,
      255,
      0,
      255,
    ]);
  });

  it("sizes the canvas to the raster, and releases its backing store afterwards", () => {
    const { canvases, readAt } = stubDocument();
    rasterDataUrl(raster(), palette);
    expect(readAt).toEqual([[3, 2]]);
    expect(canvases[0].width).toBe(0);
    expect(canvases[0].height).toBe(0);
  });

  it("is null where there is no document (the server)", () => {
    vi.stubGlobal("document", undefined);
    expect(rasterDataUrl(raster(), palette)).toBeNull();
  });

  it("is null with no 2D context, or when the canvas will not be read, or when it answers something else", () => {
    stubDocument({ context: false });
    expect(rasterDataUrl(raster(), palette)).toBeNull();
    stubDocument({
      toDataURL: () => {
        throw new Error("tainted");
      },
    });
    expect(rasterDataUrl(raster(), palette)).toBeNull();
    stubDocument({ toDataURL: () => "data:," });
    expect(rasterDataUrl(raster(), palette)).toBeNull();
  });

  it("releases the canvas even when reading it throws", () => {
    const { canvases } = stubDocument({
      toDataURL: () => {
        throw new Error("tainted");
      },
    });
    rasterDataUrl(raster(), palette);
    expect(canvases[0].width).toBe(0);
  });
});

describe("rasterPalette", () => {
  it("reads each band's colour from its token now, trimmed", () => {
    stubDocument({
      styles: { "--wx-aqi-1": " #00e400", "--wx-aqi-2": "rgb(255, 255, 0)" },
    });
    expect(rasterPalette(raster())).toEqual([
      [0, 228, 0],
      [255, 255, 0],
    ]);
  });

  it("draws a band whose token cannot be read neutral grey, never leaves it out", () => {
    stubDocument({ styles: { "--wx-aqi-1": "#00e400" } });
    expect(rasterPalette(raster())).toEqual([
      [0, 228, 0],
      [128, 128, 128],
    ]);
  });

  it("is all neutral grey with no document", () => {
    vi.stubGlobal("document", undefined);
    expect(rasterPalette(raster())).toEqual([
      [128, 128, 128],
      [128, 128, 128],
    ]);
  });
});
