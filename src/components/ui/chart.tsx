"use client";

import * as React from "react";
import {
  Chart as ChartJS,
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
ChartJS.register(
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

function resolveColor(color: string): string {
  if (typeof window === "undefined") return color;
  if (!color.startsWith("var(")) return color;
  const prop = color.replace(/^var\(/, "").replace(/\)$/, "").trim();
  try {
    const resolved = getComputedStyle(document.documentElement).getPropertyValue(prop).trim();
    // Return the resolved value only if non-empty, otherwise fall back to the
    // raw CSS var string so Chart.js never receives an empty color.
    return resolved || color;
  } catch {
    return color;
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
