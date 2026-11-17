/**
 * The class strings of the hero's data card, in one place: the live card
 * (HeroDataCard, HeroDayCurve) and its loading skeleton (HeroSkeleton) both
 * read them, so the placeholder is the card's box row for row and nothing
 * moves when the weather arrives. Type sizes are the `--text-*` tokens, the
 * gaps and insets are the Bundu floor tokens, the radius a Mzizi token.
 * Complete class names (never built from parts) so Tailwind keeps them.
 */

/** The one surface under the sky: Mzizi card surface, line and radius. */
export const HERO_CARD_CLASS = "acacia pb-[var(--gap-floor)] text-text-primary";

export const HERO_CAPTION =
  "text-[length:var(--text-caption)] leading-[var(--text-caption-leading)]";
export const HERO_FIGURE =
  "text-[length:var(--text-h6)] leading-[var(--text-h6-leading)] font-semibold tabular-nums text-text-primary";

/** The five-hour strip: equal columns, however many hours there are. */
export const HERO_STRIP_CLASS =
  "grid grid-flow-col auto-cols-fr gap-[var(--gap-floor)] border-b border-border pb-[var(--gap-floor)]";
export const HERO_STRIP_CELL_CLASS = "min-w-0 text-center";

/** The curve's drawing; the skeleton adds the box's height to it. */
export const HERO_CURVE_CLASS = "mt-3 block w-full";
/** The curve box's height in rem (116px at the 16px root, it grows with text). */
export const HERO_CURVE_HEIGHT_CLASS = "h-[7.25rem]";

/** Feels, Wind and UV: equal tiles, each a label over a figure. */
export const HERO_READINGS_CLASS =
  "mt-[var(--space-stack)] grid grid-flow-col auto-cols-fr gap-[var(--gap-floor)]";
export const HERO_READING_CLASS =
  "min-w-0 rounded-[var(--radius-input)] bg-surface-dim px-[var(--inset-floor)] py-[var(--gap-floor)]";

/** The card's last row: a 49px (the floor's target) full-width line. */
export const HERO_ROW_CLASS =
  "mt-[var(--space-stack)] flex min-h-[var(--touch-target-min)] w-full items-center gap-3 border-t border-border text-[length:var(--text-body)] leading-[var(--text-body-leading)] font-semibold text-text-primary";
