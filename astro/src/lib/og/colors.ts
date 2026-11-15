/**
 * The OG card's colours (the Mzizi "hive" template, mzizi:discoverability).
 * Text colours are checked against the ground with APCA in `og.test.ts`; the
 * floor the skill states is Lc 75 for large text and Lc 90 for body text.
 * Mineral accents are the dark-theme steps of the seven minerals, as in
 * `public/logo-dark.svg`.
 */
export const GROUND = "#1B1A17";
export const TITLE = "#F5F5F4";
export const SECONDARY = "#E5E3DE";
export const DOMAIN = "#FFD740";

export const MINERALS = {
  cobalt: "#00B0FF",
  gold: "#FFD740",
  tanzanite: "#B388FF",
  malachite: "#64FFDA",
  copper: "#FF8A65",
} as const;

function channel(hex: string, i: number): number {
  const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
  return v ** 2.4;
}

function luminance(hex: string): number {
  const y =
    0.2126729 * channel(hex, 0) +
    0.7151522 * channel(hex, 1) +
    0.072175 * channel(hex, 2);
  // Soft clamp near black (APCA-W3 0.0.98G).
  return y < 0.022 ? y + (0.022 - y) ** 1.414 : y;
}

/**
 * APCA lightness contrast (APCA-W3 0.0.98G-4g), as a positive number: how
 * readable `text` is on `background`. The Mzizi MCP's checker computes WCAG 2
 * ratios only, so this is computed here.
 */
export function apca(text: string, background: string): number {
  const yt = luminance(text);
  const yb = luminance(background);
  if (Math.abs(yb - yt) < 0.0005) return 0;
  if (yb > yt) {
    const s = (yb ** 0.56 - yt ** 0.57) * 1.14;
    return s < 0.1 ? 0 : (s - 0.027) * 100;
  }
  const s = (yb ** 0.65 - yt ** 0.62) * 1.14;
  return s > -0.1 ? 0 : Math.abs((s + 0.027) * 100);
}
