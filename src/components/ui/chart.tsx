"use client";

import * as React from "react";
import {
  Chart as ChartJS,
  LineController,
  BarController,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Filler,
  Tooltip,
  Legend,
  type ChartData,
  type ChartOptions,
  type ChartType,
  type Plugin,
} from "chart.js";
import { Chart } from "react-chartjs-2";

// ── Register Chart.js modules ──────────────────────────────────────────────
// Tree-shaken: only the modules we use are included in the bundle.
// IMPORTANT: Chart.js 4 requires controllers (LineController, BarController)
// in addition to elements (LineElement, BarElement). Without controllers,
// chart types like "line" and "bar" are not recognised at runtime.
ChartJS.register(
  LineController,
  BarController,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Filler,
  Tooltip,
  Legend,
);

// ── Chart config types ─────────────────────────────────────────────────────
// Chart config type for colour/label definitions per dataset key.

export type ChartConfig = {
  [k in string]: {
    label?: React.ReactNode;
    icon?: React.ComponentType;
  } & (
    | { color?: string; theme?: never }
    | { color?: never; theme: Record<"light" | "dark", string> }
  );
};

// ── CSS variable resolver ──────────────────────────────────────────────────
// Chart.js needs actual colour values, not CSS custom property references.
// We resolve `var(--foo)` at render time so charts respect theme switches.
// If resolution fails (SSR, DOM not ready, CSS not loaded), we return a
// sensible fallback colour so Chart.js always gets a valid value.

// Theme-aware fallbacks — when getComputedStyle fails (SSR, early render,
// CSS not yet parsed), we need valid hex colors for Chart.js Canvas rendering.
// Without these, the Canvas 2D context receives invalid values and defaults
// to black, which is the root cause of the "opacity renders as black" bug.
//
// IMPORTANT: Both tables must have identical keys. Values must stay in sync
// with the CSS custom properties in src/app/globals.css. A CI test in
// src/components/ui/chart-fallbacks.test.ts verifies key parity.
const CSS_VAR_FALLBACKS_LIGHT: Record<string, string> = {
  "--chart-1": "#4B0082",    // Tanzanite
  "--chart-2": "#0047AB",    // Cobalt
  "--chart-3": "#2D6A4F",    // Malachite
  "--chart-4": "#B8860B",    // Gold
  "--chart-5": "#C1440E",    // Terracotta
  "--color-text-primary": "#141413",
  "--color-text-secondary": "#52524E",
  "--color-text-tertiary": "#8C8B87",
  "--color-surface-card": "#FFFFFF",
  "--color-rain": "#0288D1",
  "--mineral-malachite": "#004D40",
  "--mineral-terracotta": "#8B4513",
  "--mineral-cobalt": "#0047AB",
  "--mineral-tanzanite": "#4B0082",
  "--mineral-gold": "#B8860B",
  "--color-mineral-malachite": "#004D40",
  "--color-mineral-terracotta": "#8B4513",
  "--color-mineral-cobalt": "#0047AB",
  "--color-mineral-tanzanite": "#4B0082",
  "--color-mineral-gold": "#B8860B",
  "--color-severity-low": "#004D40",
  "--color-severity-moderate": "#5D4037",
  "--color-severity-high": "#BF5700",
  "--color-severity-severe": "#B3261E",
  "--color-severity-extreme": "#7F0000",
  "--color-severity-cold": "#0047AB",
};

const CSS_VAR_FALLBACKS_DARK: Record<string, string> = {
  "--chart-1": "#B388FF",    // Tanzanite light
  "--chart-2": "#00B0FF",    // Cobalt light
  "--chart-3": "#64FFDA",    // Malachite light
  "--chart-4": "#FFD740",    // Gold light
  "--chart-5": "#D4A574",    // Terracotta light
  "--color-text-primary": "#F3F3F0",
  "--color-text-secondary": "#B5B5B0",
  "--color-text-tertiary": "#6B6B66",
  "--color-surface-card": "#1E1E1C",
  "--color-rain": "#4FC3F7",
  "--mineral-malachite": "#69F0AE",
  "--mineral-terracotta": "#D4A574",
  "--mineral-cobalt": "#42A5F5",
  "--mineral-tanzanite": "#B388FF",
  "--mineral-gold": "#FFD740",
  "--color-mineral-malachite": "#69F0AE",
  "--color-mineral-terracotta": "#D4A574",
  "--color-mineral-cobalt": "#42A5F5",
  "--color-mineral-tanzanite": "#B388FF",
  "--color-mineral-gold": "#FFD740",
  "--color-severity-low": "#64FFDA",
  "--color-severity-moderate": "#FFD740",
  "--color-severity-high": "#FF9800",
  "--color-severity-severe": "#FF5252",
  "--color-severity-extreme": "#FF1744",
  "--color-severity-cold": "#42A5F5",
};

function isDarkMode(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.getAttribute("data-theme") === "dark";
}

function getFallback(prop: string): string | undefined {
  const map = isDarkMode() ? CSS_VAR_FALLBACKS_DARK : CSS_VAR_FALLBACKS_LIGHT;
  return map[prop];
}

function resolveColor(color: string): string {
  if (typeof window === "undefined") {
    // SSR: return fallback if available, otherwise the raw var string
    if (color.startsWith("var(")) {
      const prop = color.replace(/^var\(/, "").replace(/\)$/, "").trim();
      return CSS_VAR_FALLBACKS_LIGHT[prop] ?? color;
    }
    return color;
  }
  if (!color.startsWith("var(")) return color;
  const prop = color.replace(/^var\(/, "").replace(/\)$/, "").trim();
  try {
    const resolved = getComputedStyle(document.documentElement).getPropertyValue(prop).trim();
    // Return the resolved value if non-empty, otherwise use theme-aware fallback
    return resolved || getFallback(prop) || color;
  } catch {
    return getFallback(prop) || color;
  }
}

// ── Resolve all config colours ─────────────────────────────────────────────

function resolveConfigColors(config: ChartConfig): Record<string, string> {
  const resolved: Record<string, string> = {};
  const isDark =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "dark";

  for (const [key, cfg] of Object.entries(config)) {
    if (cfg.theme) {
      resolved[key] = resolveColor(isDark ? cfg.theme.dark : cfg.theme.light);
    } else if (cfg.color) {
      resolved[key] = resolveColor(cfg.color);
    }
  }
  return resolved;
}

// ── Canvas chart container ─────────────────────────────────────────────────

interface CanvasChartProps<T extends ChartType = ChartType> {
  /** Chart.js chart type — typically "line", "bar", or "scatter" */
  type: T;
  /** Chart.js data config — datasets + labels */
  data: ChartData<T>;
  /** Chart.js options */
  options?: ChartOptions<T>;
  /** Plugin list (passed per-instance) */
  plugins?: Plugin<T>[];
  /** ChartConfig for colour resolution — kept for API compat */
  config: ChartConfig;
  /** Container class names (aspect ratio, width, etc.) */
  className?: string;
}

/**
 * Canvas-based chart wrapper built on Chart.js + react-chartjs-2.
 *
 * Each chart is a single `<canvas>` DOM element regardless of data volume.
 * 7 charts × 365 data points = 7 DOM elements (vs thousands of SVG nodes).
 *
 * Resolves CSS custom properties to concrete values so Chart.js receives
 * real colours. Automatically updates when the theme changes.
 * Destroys Chart.js instances on unmount to prevent canvas memory leaks.
 */
export function CanvasChart<T extends ChartType = ChartType>({
  type,
  data,
  options,
  plugins,
  config,
  className,
}: CanvasChartProps<T>) {
  const chartRef = React.useRef<ChartJS<T>>(null);

  // Resolve colours for the dependency hash — triggers re-render on theme change.
  const resolvedColors = resolveConfigColors(config);
  // Simple hash to detect colour changes without deep comparison
  const colorHash = Object.values(resolvedColors).join(",");

  // Mobile performance: disable animations and reduce DPR
  const isMobile =
    typeof window !== "undefined" && window.innerWidth < 768;

  // Destroy the Chart.js instance on unmount to prevent canvas memory leaks.
  // Without this, LazySection's bidirectional unmount leaves orphaned Chart
  // instances holding canvas image data in the JS heap, causing OOM on mobile.
  React.useEffect(() => {
    return () => {
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
    };
  }, []);

  const mergedOptions: ChartOptions<T> = React.useMemo(() => {
    const base: ChartOptions<ChartType> = {
      responsive: true,
      maintainAspectRatio: true,
      animation: isMobile ? false : { duration: 300 },
      devicePixelRatio: isMobile ? 1 : undefined,
      interaction: {
        mode: "index" as const,
        intersect: false,
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: resolveColor("var(--color-surface-card)"),
          titleColor: resolveColor("var(--color-text-primary)"),
          bodyColor: resolveColor("var(--color-text-secondary)"),
          borderColor: resolveColor("var(--color-text-tertiary)"),
          borderWidth: 1,
          padding: 8,
          boxPadding: 4,
          cornerRadius: 8,
          titleFont: { size: 12 },
          bodyFont: { size: 11 },
          displayColors: true,
          usePointStyle: true,
        },
      },
    };

    // Deep merge user options over base
    return deepMerge(base, (options ?? {}) as Record<string, unknown>) as ChartOptions<T>;
  }, [options, isMobile, colorHash]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={className} data-slot="chart">
      <Chart
        ref={chartRef}
        type={type}
        data={data}
        options={mergedOptions}
        plugins={plugins}
      />
    </div>
  );
}

// ── Deep merge utility ─────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (isPlainObject(source[key]) && isPlainObject(out[key])) {
      out[key] = deepMerge(
        out[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>,
      );
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

// ── Re-exports for backward compat ─────────────────────────────────────────
// These allow existing chart components to keep the same import path.

export { resolveColor, resolveConfigColors };

// Exported for test-only verification that light/dark fallback tables have identical keys.
export { CSS_VAR_FALLBACKS_LIGHT as _CSS_VAR_FALLBACKS_LIGHT, CSS_VAR_FALLBACKS_DARK as _CSS_VAR_FALLBACKS_DARK };
