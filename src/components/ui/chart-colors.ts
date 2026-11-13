/**
 * Chart colours: the CSS-variable resolver and the fallback tables, kept apart
 * from `chart.tsx` on purpose. `chart.tsx` imports Chart.js (about 160 KB), and
 * `MetricCard`, which the first screen renders, only needs to turn a
 * `var(--token)` into a colour. Importing the resolver from there put Chart.js
 * on the first screen's critical path (issue #551). Nothing here may import
 * `chart.js` or `react-chartjs-2`.
 */
import type * as React from "react";

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
  "--chart-1": "#4B0082", // Tanzanite
  "--chart-2": "#0047AB", // Cobalt
  "--chart-3": "#2D6A4F", // Malachite
  "--chart-4": "#B8860B", // Gold
  "--chart-5": "#C1440E", // Terracotta
  "--chart-6": "#283593", // Sodalite
  "--chart-7": "#8A4B2A", // Copper (Apple Weather series)
  "--color-primary": "#0047AB",
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
  "--wx-series-temp": "#D73027",
  "--wx-series-temp-low": "#4575B4",
  "--wx-series-feels": "#B8570B",
  "--wx-series-rain": "#0B6FB8",
  "--wx-series-rain-prob": "#08519C",
  "--wx-series-wind": "#2A9D8F",
  "--wx-series-gust": "#1B6A5F",
  "--wx-series-cloud": "#6B7280",
  "--wx-series-humidity": "#238B45",
  "--wx-series-pressure": "#6A51A3",
  "--wx-series-dew": "#0E7490",
  "--wx-series-visibility": "#525252",
  "--wx-series-storm": "#7B3294",
  "--wx-uv-1": "#299501",
  "--wx-uv-2": "#F7E400",
  "--wx-uv-3": "#F85900",
  "--wx-uv-4": "#D8001D",
  "--wx-uv-5": "#6B49C8",
};

const CSS_VAR_FALLBACKS_DARK: Record<string, string> = {
  "--chart-1": "#B388FF", // Tanzanite light
  "--chart-2": "#00B0FF", // Cobalt light
  "--chart-3": "#64FFDA", // Malachite light
  "--chart-4": "#FFD740", // Gold light
  "--chart-5": "#D4A574", // Terracotta light
  "--chart-6": "#3D5AFE", // Sodalite light
  "--chart-7": "#FF8A65", // Copper light
  "--color-primary": "#00B0FF",
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
  "--wx-series-temp": "#F4806F",
  "--wx-series-temp-low": "#74ADD1",
  "--wx-series-feels": "#FDAE61",
  "--wx-series-rain": "#4FC3F7",
  "--wx-series-rain-prob": "#9ECAE1",
  "--wx-series-wind": "#5FD3C4",
  "--wx-series-gust": "#8FE0D3",
  "--wx-series-cloud": "#A1A1AA",
  "--wx-series-humidity": "#74C476",
  "--wx-series-pressure": "#B2A3E0",
  "--wx-series-dew": "#67D1E6",
  "--wx-series-visibility": "#A3A3A3",
  "--wx-series-storm": "#C996DD",
  "--wx-uv-1": "#299501",
  "--wx-uv-2": "#F7E400",
  "--wx-uv-3": "#F85900",
  "--wx-uv-4": "#D8001D",
  "--wx-uv-5": "#6B49C8",
};

function isDarkMode(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.getAttribute("data-theme") === "dark";
}

function getFallback(prop: string): string | undefined {
  const map = isDarkMode() ? CSS_VAR_FALLBACKS_DARK : CSS_VAR_FALLBACKS_LIGHT;
  return map[prop];
}

/**
 * Lowercase hex colours so the server (fallback table, uppercase) and the
 * client (`getComputedStyle`, lowercase as written in globals.css) emit
 * byte-identical strings. Without this, SVG paint attributes such as
 * `stopColor` differ only by case and trigger a React hydration warning.
 * Non-hex values (rgb(), named colours, raw var() strings) pass through as-is.
 */
export function normaliseColor(color: string): string {
  return /^#[0-9a-f]{3,8}$/i.test(color) ? color.toLowerCase() : color;
}

function resolveColor(color: string): string {
  return normaliseColor(resolveColorRaw(color));
}

/**
 * The value the server renders for a colour: the light fallback table, never
 * the browser's computed style (the server cannot know the viewer's theme).
 * Components that resolve colours during hydration must start from this so
 * their first client render matches the server HTML in both themes; the real
 * computed colours are applied afterwards in an effect.
 */
export function resolveFallbackColor(color: string): string {
  if (!color.startsWith("var(")) return normaliseColor(color);
  const prop = color
    .replace(/^var\(/, "")
    .replace(/\)$/, "")
    .trim();
  return normaliseColor(CSS_VAR_FALLBACKS_LIGHT[prop] ?? color);
}

function resolveColorRaw(color: string): string {
  if (typeof window === "undefined") {
    // SSR: return fallback if available, otherwise the raw var string
    if (color.startsWith("var(")) {
      const prop = color
        .replace(/^var\(/, "")
        .replace(/\)$/, "")
        .trim();
      return CSS_VAR_FALLBACKS_LIGHT[prop] ?? color;
    }
    return color;
  }
  if (!color.startsWith("var(")) return color;
  const prop = color
    .replace(/^var\(/, "")
    .replace(/\)$/, "")
    .trim();
  try {
    const resolved = getComputedStyle(document.documentElement)
      .getPropertyValue(prop)
      .trim();
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

export { resolveColor, resolveConfigColors };

// Exported for test-only verification that light/dark fallback tables have identical keys.
export {
  CSS_VAR_FALLBACKS_LIGHT as _CSS_VAR_FALLBACKS_LIGHT,
  CSS_VAR_FALLBACKS_DARK as _CSS_VAR_FALLBACKS_DARK,
};
