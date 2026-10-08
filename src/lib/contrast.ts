/**
 * WCAG 2.x contrast helpers (relative luminance + contrast ratio).
 *
 * Used by the a11y token tests to prove that colour pairs in `globals.css`
 * meet WCAG thresholds (4.5:1 for body text, 3:1 for non-text UI such as
 * focus rings). Pure functions — no DOM, no CSS parsing.
 */

/** Parse `#rgb` or `#rrggbb` into 0–255 channel values. */
export function parseHex(hex: string): [number, number, number] {
  const raw = hex.trim().replace(/^#/, "");
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`contrast: not a hex colour: ${hex}`);
  }
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** WCAG relative luminance of a hex colour (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((channel) => {
    const v = channel / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colours, always >= 1. */
export function contrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}
