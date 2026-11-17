"use client";

import { useRef } from "react";
import { Shimmer } from "@/components/ui/shimmer";
import { useRegisterSkyHero } from "@/lib/sky-hero";
import { HERO_STRIP_HOURS } from "@/lib/hero-card";
import {
  HERO_CAPTION,
  HERO_CARD_CLASS,
  HERO_CURVE_CLASS,
  HERO_CURVE_HEIGHT_CLASS,
  HERO_FIGURE,
  HERO_READINGS_CLASS,
  HERO_READING_CLASS,
  HERO_ROW_CLASS,
  HERO_STRIP_CELL_CLASS,
  HERO_STRIP_CLASS,
} from "@/components/weather/hero-card-classes";

/**
 * A typical outlook, laid out invisibly to give the placeholder its real
 * height at every width (the live line holds two lines while its clock is
 * unknown). The sentence is the middle of what the page shows: one or two
 * clauses, about 55 characters. Never drawn, `aria-hidden` with the rest.
 */
export const TYPICAL_OUTLOOK =
  "Clear until 15:00. Gusts reach 31 km/h this afternoon.";

/**
 * One bar per wrapped line of the outlook: the shimmer fills the paragraph's
 * text box and a repeating mask (period 1.6em, `--text-body-leading`) keeps a
 * 0.7em bar per line. Both the standard and the `-webkit-` property, since
 * the arbitrary values are not prefixed for us.
 */
const OUTLOOK_BARS_CLASS =
  "absolute top-0 right-[8%] bottom-0 left-0 [-webkit-mask-image:repeating-linear-gradient(to_bottom,transparent_0,transparent_0.45em,currentColor_0.45em,currentColor_1.15em,transparent_1.15em,transparent_1.6em)] [mask-image:repeating-linear-gradient(to_bottom,transparent_0,transparent_0.45em,currentColor_0.45em,currentColor_1.15em,transparent_1.15em,transparent_1.6em)]";

/**
 * The hero's placeholder: the ONE place the skeleton's hero geometry lives.
 * When the location hero changes shape (CurrentConditions, HeroDataCard),
 * change this file only; LocationSkeleton just renders `<HeroSkeleton />`.
 *
 * It is the hero's box, row for row. The open sky: the 49px top row
 * (breadcrumb bar at the left; the Quick actions group is the layout's,
 * already on screen and live while the place loads, so there is nothing to
 * stand in for), then the stack (`pt-4 pb-[26px]`): the identity grid (eyebrow
 * line, name and country at the left, the 56px glyph in its own column), the
 * numeral (Display), the condition (H5), the H/L/Feels line (Body Large) and
 * the outlook (Body, two lines). Then the data card under it: the five-hour
 * strip, the curve's box, the three readings and the activities row, from the
 * same class strings as the live card (hero-card-classes.ts). Every sky row
 * carries the REAL `--text-*` size and leading around an `em`-sized bar, so
 * each row is exactly as tall as the text it stands in for and the hero does
 * not change size when the content arrives. The sky has no card or plate:
 * calm bars straight on the page sky (the same `.kestrel` gradient the page
 * paints); only the data card is a surface, as it is when loaded. It carries
 * `data-sky-hero`, so the phone header is hidden exactly as the real hero
 * hides it and loading does not jump to loaded. It also registers itself as
 * the sky hero (without a place), so the Quick actions group is already clear
 * over it and does not change look when the real hero replaces it. Quiet bars
 * only: no wordmark, no sentence, no spinner.
 */
export function HeroSkeleton() {
  const contentRef = useRef<HTMLParagraphElement>(null);
  useRegisterSkyHero(contentRef, null);
  return (
    <div
      aria-hidden="true"
      className="pr-[env(safe-area-inset-right,0px)] pl-[env(safe-area-inset-left,0px)]"
    >
      <section
        aria-hidden="true"
        data-sky-hero
        data-skeleton="hero"
        className="relative text-[var(--sky-fg)]"
      >
        <div className="flex items-center justify-between gap-3 pt-1">
          {/* The breadcrumb's box: a typical trail laid out invisibly (so it
              wraps on a narrow phone exactly as the real one does and the top
              row has the same height), with one quiet bar drawn over it. */}
          <div className="relative min-h-[var(--touch-target-min)] min-w-0 pr-[var(--hadeda-reserve)] text-[length:var(--text-body-sm)] leading-[var(--text-body-sm-leading)] sm:pr-0">
            <ol className="invisible flex flex-wrap items-center gap-x-1.5">
              <li>
                <span className="dik-dik">Home</span>
              </li>
              <li>/</li>
              <li>Zimbabwe</li>
              <li>/</li>
              <li>Harare</li>
            </ol>
            <Shimmer className="absolute top-1/2 left-0 h-[0.8em] w-40 max-w-full -translate-y-1/2" />
          </div>
        </div>
        <div className="pt-4 pb-[26px]">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 min-[360px]:gap-x-3">
            <p
              ref={contentRef}
              className="col-start-1 row-start-1 min-h-[calc(var(--text-caption)*var(--text-caption-leading))] text-[length:var(--text-caption)] leading-[var(--text-caption-leading)]"
            >
              <Shimmer className="h-[0.7em] w-24" />
            </p>
            <p className="col-start-1 row-start-2 font-heading text-[length:var(--text-h2)] leading-[var(--text-h2-leading)] font-semibold max-[359px]:text-[length:var(--text-h3)] max-[359px]:leading-[var(--text-h3-leading)]">
              <Shimmer className="h-[0.7em] w-44" />
            </p>
            <p className="col-start-1 row-start-3 text-[length:var(--text-body-sm)] leading-[var(--text-body-sm-leading)]">
              <Shimmer className="h-[0.7em] w-20" />
            </p>
            <span className="col-start-2 row-span-3 row-start-1 self-center block size-10 min-[360px]:size-14">
              <Shimmer className="block size-full rounded-full" />
            </span>
          </div>
          <p className="mt-3 font-sans text-[length:var(--text-display)] leading-[var(--text-display-leading)] font-normal">
            <Shimmer className="h-[0.7em] w-[1.6em]" />
          </p>
          <p className="mt-1 text-[length:var(--text-h5)] leading-[var(--text-h5-leading)] font-semibold">
            <Shimmer className="h-[0.7em] w-28" />
          </p>
          <p className="mt-1 text-[length:var(--text-body-lg)] leading-[var(--text-body-lg-leading)] font-semibold">
            <Shimmer className="h-[0.7em] w-48" />
          </p>
          {/* The outlook: a typical sentence laid out invisibly, so it wraps at
              the real width as the sentence does; one quiet bar per wrapped
              line is drawn over it by a repeating mask of one line height. */}
          <p className="relative mt-3 max-w-[40ch] text-pretty text-[length:var(--text-body)] leading-[var(--text-body-leading)]">
            <span className="invisible">{TYPICAL_OUTLOOK}</span>
            <Shimmer className={OUTLOOK_BARS_CLASS} />
          </p>
        </div>
      </section>
      {/* The data card: the live card's surface and rows, with bars. */}
      <div data-skeleton="hero-card" className={HERO_CARD_CLASS}>
        <ol className={HERO_STRIP_CLASS}>
          {Array.from({ length: HERO_STRIP_HOURS }, (_, i) => (
            <li key={i} className={HERO_STRIP_CELL_CLASS}>
              <span className={`block ${HERO_CAPTION}`}>
                <Shimmer className="mx-auto h-[0.7em] w-9" />
              </span>
              <span className={`block ${HERO_FIGURE}`}>
                <Shimmer className="mx-auto h-[0.7em] w-8" />
              </span>
            </li>
          ))}
        </ol>
        <div
          className={`${HERO_CURVE_CLASS} ${HERO_CURVE_HEIGHT_CLASS} relative`}
        >
          <Shimmer className="absolute inset-x-0 top-[30%] bottom-[28%] rounded-[var(--radius-input)]" />
        </div>
        <div className={HERO_READINGS_CLASS}>
          {[0, 1, 2].map((i) => (
            <div key={i} className={HERO_READING_CLASS}>
              <p className={HERO_CAPTION}>
                <Shimmer className="h-[0.7em] w-10" />
              </p>
              <p className={HERO_FIGURE}>
                <Shimmer className="h-[0.7em] w-12" />
              </p>
            </div>
          ))}
        </div>
        <div className={HERO_ROW_CLASS}>
          <Shimmer className="h-[0.7em] w-40" />
        </div>
      </div>
    </div>
  );
}
