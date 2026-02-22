"use client";

import { useMemo } from "react";
import { CanvasChart, resolveColor, type ChartConfig } from "@/components/ui/chart";
import type { ChartData, ChartOptions } from "chart.js";

/**
 * Safely apply alpha to a resolved color string.
 * Supports all CSS color formats used by Chart.js Canvas 2D context:
 * - Hex: #RGB, #RRGGBB, #RRGGBBAA
 * - RGB/RGBA: rgb(r, g, b), rgba(r, g, b, a)
 * - HSL/HSLA: hsl(h, s%, l%), hsla(h, s%, l%, a), hsl(h s% l%)
 * - OKLCH: oklch(L C H), oklch(L C H / a) — Tailwind CSS 4 format
 * - HWB: hwb(h w% b%), hwb(h w% b% / a)
 * - Named CSS colors: red, blue, coral, etc.
 *
 * Returns transparent black for invalid/unresolved inputs rather than
 * producing malformed color strings that Canvas renders as opaque black.
 */
export function hexWithAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  // Guard: reject empty, undefined, or unresolved CSS variable strings
  if (!color || color.startsWith("var(")) {
    return `rgba(0, 0, 0, ${a})`;
  }

  // rgb(r, g, b) or rgba(r, g, b, a) — legacy comma syntax
  const rgbMatch = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgbMatch) {
    return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${a})`;
  }

  // rgb(r g b) or rgb(r g b / a) — modern space syntax
  const rgbSpaceMatch = color.match(/^rgba?\(\s*(\d+)\s+(\d+)\s+(\d+)/);
  if (rgbSpaceMatch) {
    return `rgba(${rgbSpaceMatch[1]}, ${rgbSpaceMatch[2]}, ${rgbSpaceMatch[3]}, ${a})`;
  }

  // hsl(h, s%, l%) or hsla(h, s%, l%, a) — legacy comma syntax
  const hslMatch = color.match(/^hsla?\(\s*([\d.]+),\s*([\d.]+)%,\s*([\d.]+)%/);
  if (hslMatch) {
    return `hsla(${hslMatch[1]}, ${hslMatch[2]}%, ${hslMatch[3]}%, ${a})`;
  }

  // hsl(h s% l%) or hsl(h s% l% / a) — modern space syntax
  const hslSpaceMatch = color.match(/^hsla?\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
  if (hslSpaceMatch) {
    return `hsla(${hslSpaceMatch[1]}, ${hslSpaceMatch[2]}%, ${hslSpaceMatch[3]}%, ${a})`;
  }

  // oklch(L C H) or oklch(L C H / a) — Tailwind CSS 4 format
  const oklchMatch = color.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (oklchMatch) {
    return `oklch(${oklchMatch[1]} ${oklchMatch[2]} ${oklchMatch[3]} / ${a})`;
  }

  // hwb(h w% b%) or hwb(h w% b% / a) — CSS Level 4
  const hwbMatch = color.match(/^hwb\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
  if (hwbMatch) {
    return `hwb(${hwbMatch[1]} ${hwbMatch[2]}% ${hwbMatch[3]}% / ${a})`;
  }

  // Hex: validate format before parsing
  if (color.startsWith("#")) {
    if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) {
      return `rgba(0, 0, 0, ${a})`;
    }
    const hex = color.replace(/^#/, "");
    // Expand shorthand hex (#RGB → RRGGBB, #RGBA → RRGGBB) before appending alpha.
    // Without expansion, appending a 2-char alpha to 3 digits produces a 5-char
    // string that is not a valid CSS color (e.g. "#FFF80" instead of "#FFFFFF80").
    let base: string;
    if (hex.length === 3) {
      base = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    } else if (hex.length === 4) {
      base = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    } else if (hex.length === 8) {
      base = hex.slice(0, 6);
    } else {
      base = hex;
    }
    return `#${base}${Math.round(a * 255).toString(16).padStart(2, "0")}`;
  }

  // Named CSS colors — Canvas 2D context supports these natively.
  // Validate against the CSS named color list for safety.
  if (CSS_NAMED_COLORS.has(color.toLowerCase())) {
    // Canvas supports named colors but not named + alpha.
    // Convert via the NAMED_COLOR_RGB map for rgba output.
    const rgb = NAMED_COLOR_RGB[color.toLowerCase()];
    if (rgb) {
      return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
    }
  }

  // Unknown format — transparent black fallback
  return `rgba(0, 0, 0, ${a})`;
}

/** CSS named colors (Level 4) for validation. */
const CSS_NAMED_COLORS = new Set([
  "black", "silver", "gray", "white", "maroon", "red", "purple", "fuchsia",
  "green", "lime", "olive", "yellow", "navy", "blue", "teal", "aqua",
  "aliceblue", "antiquewhite", "aquamarine", "azure", "beige", "bisque",
  "blanchedalmond", "blueviolet", "brown", "burlywood", "cadetblue",
  "chartreuse", "chocolate", "coral", "cornflowerblue", "cornsilk", "crimson",
  "cyan", "darkblue", "darkcyan", "darkgoldenrod", "darkgray", "darkgreen",
  "darkgrey", "darkkhaki", "darkmagenta", "darkolivegreen", "darkorange",
  "darkorchid", "darkred", "darksalmon", "darkseagreen", "darkslateblue",
  "darkslategray", "darkslategrey", "darkturquoise", "darkviolet", "deeppink",
  "deepskyblue", "dimgray", "dimgrey", "dodgerblue", "firebrick",
  "floralwhite", "forestgreen", "gainsboro", "ghostwhite", "gold", "goldenrod",
  "greenyellow", "grey", "honeydew", "hotpink", "indianred", "indigo",
  "ivory", "khaki", "lavender", "lavenderblush", "lawngreen", "lemonchiffon",
  "lightblue", "lightcoral", "lightcyan", "lightgoldenrodyellow", "lightgray",
  "lightgreen", "lightgrey", "lightpink", "lightsalmon", "lightseagreen",
  "lightskyblue", "lightslategray", "lightslategrey", "lightsteelblue",
  "lightyellow", "limegreen", "linen", "magenta", "mediumaquamarine",
  "mediumblue", "mediumorchid", "mediumpurple", "mediumseagreen",
  "mediumslateblue", "mediumspringgreen", "mediumturquoise", "mediumvioletred",
  "midnightblue", "mintcream", "mistyrose", "moccasin", "navajowhite",
  "oldlace", "olivedrab", "orange", "orangered", "orchid", "palegoldenrod",
  "palegreen", "paleturquoise", "palevioletred", "papayawhip", "peachpuff",
  "peru", "pink", "plum", "powderblue", "rosybrown", "royalblue",
  "saddlebrown", "salmon", "sandybrown", "seagreen", "seashell", "sienna",
  "skyblue", "slateblue", "slategray", "slategrey", "snow", "springgreen",
  "steelblue", "tan", "thistle", "tomato", "turquoise", "violet", "wheat",
  "whitesmoke", "yellowgreen", "rebeccapurple", "transparent",
]);

/** RGB values for common named colors used in charts/weather UI. */
const NAMED_COLOR_RGB: Record<string, [number, number, number]> = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0],
  green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0],
  cyan: [0, 255, 255], magenta: [255, 0, 255], orange: [255, 165, 0],
  purple: [128, 0, 128], coral: [255, 127, 80], crimson: [220, 20, 60],
  gold: [255, 215, 0], indigo: [75, 0, 130], teal: [0, 128, 128],
  navy: [0, 0, 128], maroon: [128, 0, 0], olive: [128, 128, 0],
  silver: [192, 192, 192], gray: [128, 128, 128], grey: [128, 128, 128],
  lime: [0, 255, 0], aqua: [0, 255, 255], fuchsia: [255, 0, 255],
  salmon: [250, 128, 114], tomato: [255, 99, 71], chocolate: [210, 105, 30],
  dodgerblue: [30, 144, 255], forestgreen: [34, 139, 34],
  steelblue: [70, 130, 180], firebrick: [178, 34, 34],
  darkblue: [0, 0, 139], darkgreen: [0, 100, 0], darkred: [139, 0, 0],
  skyblue: [135, 206, 235], royalblue: [65, 105, 225],
  transparent: [0, 0, 0],
};

export interface SeriesConfig {
  key: string;
  label: string;
  color: string;
  type?: "line" | "bar";
  fill?: boolean;
  dashed?: boolean;
  yAxisID?: string;
  order?: number;
  opacity?: number;
  showDots?: boolean;
}

export interface TimeSeriesChartProps {
  /** Data points — must include a label field + numeric series fields */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>[];
  /** Which field on each data point provides the x-axis label */
  labelKey: string;
  /** Series definitions — each draws a line, area, or bar */
  series: SeriesConfig[];
  /** Y-axis configs (keyed by yAxisID or "y" for default) */
  yAxes?: Record<string, {
    min?: number;
    max?: number;
    position?: "left" | "right";
    display?: boolean;
    format?: (v: number) => string;
  }>;
  /** Custom tooltip label formatter */
  tooltipLabel?: (datasetLabel: string, value: number) => string;
  /** Custom tooltip title formatter (receives the raw label value) */
  tooltipTitle?: (label: string) => string;
  /** Custom x-axis tick formatter (receives the raw label value and index) */
  xTickFormat?: (label: string, index: number) => string;
  /** Maximum number of x-axis ticks (default 8) */
  maxTicksLimit?: number;
  /** Aspect ratio class (e.g. "aspect-[16/5]") */
  aspect?: string;
  /** Show dots on data points */
  showDots?: boolean;
}

/**
 * Reusable Canvas-based time series chart.
 *
 * Draws lines, areas, and bars on a single canvas element.
 * Used across all weather dashboards to eliminate duplication.
 *
 * Examples:
 * - Temperature trend: 2 area series + 2 dashed line series
 * - Precipitation: 1 bar series + 1 line series, dual Y axes
 * - Humidity: 1 filled area series
 */
export function TimeSeriesChart({
  data,
  labelKey,
  series,
  yAxes,
  tooltipLabel,
  tooltipTitle,
  xTickFormat,
  maxTicksLimit = 8,
  aspect = "aspect-[2/1] sm:aspect-[16/5]",
  showDots = false,
}: TimeSeriesChartProps) {
  const gridColor = resolveColor("var(--color-text-tertiary)");

  // Resolve all series colors once — used for both config and datasets.
  // Tracked as a dependency so charts re-render on theme change.
  const resolvedSeriesColors = useMemo(
    () => series.map((s) => resolveColor(s.color)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, gridColor], // gridColor changes when theme changes, triggering re-resolve
  );

  const config = useMemo(() => {
    const cfg: ChartConfig = {};
    for (const s of series) {
      cfg[s.key] = { label: s.label, color: s.color };
    }
    return cfg;
  }, [series]);

  const hasMixedTypes = series.some((s) => s.type === "bar") && series.some((s) => !s.type || s.type === "line");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartData: ChartData<any> = useMemo(() => {
    const labels = data.map((d) => d[labelKey]);
    const datasets = series.map((s, idx) => {
      const color = resolvedSeriesColors[idx];
      const isBar = s.type === "bar";
      const dotRadius = (s.showDots ?? showDots) ? 2 : 0;

      if (isBar) {
        return {
          type: "bar" as const,
          label: s.label,
          data: data.map((d) => d[s.key]),
          backgroundColor: hexWithAlpha(color, s.opacity ?? 0.6),
          borderRadius: 2,
          yAxisID: s.yAxisID ?? "y",
          order: s.order ?? 2,
        };
      }

      return {
        type: "line" as const,
        label: s.label,
        data: data.map((d) => d[s.key]),
        borderColor: color,
        backgroundColor: s.fill ? hexWithAlpha(color, s.opacity ?? 0.12) : undefined,
        borderWidth: s.dashed ? 1.5 : 2,
        borderDash: s.dashed ? [4, 3] : undefined,
        fill: s.fill ?? false,
        tension: 0.4,
        pointRadius: s.dashed ? 0 : dotRadius,
        pointHitRadius: 8,
        yAxisID: s.yAxisID ?? "y",
        order: s.order ?? 1,
      };
    });

    return { labels, datasets };
  }, [data, labelKey, series, showDots, resolvedSeriesColors]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartOptions: ChartOptions<any> = useMemo(() => {
    const scales: Record<string, unknown> = {
      x: {
        grid: { display: false },
        ticks: {
          color: gridColor,
          font: { size: 11 },
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...(xTickFormat ? { callback: (_v: any, i: number) => xTickFormat(data[i]?.[labelKey] ?? "", i) } : {}),
        },
        border: { display: false },
      },
    };

    if (yAxes) {
      for (const [id, cfg] of Object.entries(yAxes)) {
        scales[id] = {
          position: cfg.position ?? "left",
          display: cfg.display ?? true,
          min: cfg.min,
          max: cfg.max,
          grid: cfg.position === "right"
            ? { display: false }
            : { color: hexWithAlpha(gridColor, 0.15), drawTicks: false },
          ticks: {
            color: gridColor,
            font: { size: 11 },
            ...(cfg.format ? { callback: (v: string | number) => cfg.format!(Number(v)) } : {}),
          },
          border: { display: false },
        };
      }
    } else {
      scales.y = {
        grid: { color: hexWithAlpha(gridColor, 0.15), drawTicks: false },
        ticks: { color: gridColor, font: { size: 11 } },
        border: { display: false },
      };
    }

    return {
      scales,
      plugins: {
        tooltip: {
          callbacks: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            title: tooltipTitle ? (items: any[]) => tooltipTitle(data[items[0]?.dataIndex ?? 0]?.[labelKey] ?? "") : undefined,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            label: tooltipLabel ? (ctx: any) => tooltipLabel(ctx.dataset.label ?? "", ctx.parsed.y) : undefined,
          },
        },
      },
    };
  }, [data, labelKey, gridColor, yAxes, tooltipLabel, tooltipTitle, xTickFormat, maxTicksLimit]);

  const chartType = hasMixedTypes ? "bar" : (series[0]?.type ?? "line");

  return (
    <CanvasChart
      type={chartType}
      data={chartData}
      options={chartOptions}
      config={config}
      className={`${aspect} w-full`}
    />
  );
}
