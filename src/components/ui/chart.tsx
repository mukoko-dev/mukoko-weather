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
import {
  resolveColor,
  resolveConfigColors,
  type ChartConfig,
} from "./chart-colors";

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

// ── Chart text at the Bundu floor ─────────────────────────────────────────
// Everything Chart.js draws as text (axis ticks, tooltips, legends) is read by
// a person, so it is drawn at the 14px floor of Mzizi registry 4.23.0, not
// Chart.js's 12px default or the 11px the axes used (stage 2 of #479).
// A canvas cannot read CSS, so the number lives here; bundu-floor.test.ts
// keeps it at or above the --text-caption token.
export const CHART_FONT_PX = 14;
ChartJS.defaults.font.size = CHART_FONT_PX;

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
  const isMobile = typeof window !== "undefined" && window.innerWidth < 768;

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
    return deepMerge(
      base,
      (options ?? {}) as Record<string, unknown>,
    ) as ChartOptions<T>;
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
// The colour resolver moved to chart-colors.ts (it must not pull Chart.js in).
// These keep the existing import path for the chart components and tests.

export type { ChartConfig };
export {
  normaliseColor,
  resolveColor,
  resolveConfigColors,
  resolveFallbackColor,
  _CSS_VAR_FALLBACKS_LIGHT,
  _CSS_VAR_FALLBACKS_DARK,
} from "./chart-colors";
