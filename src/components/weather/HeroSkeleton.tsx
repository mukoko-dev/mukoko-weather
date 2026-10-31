import { Shimmer } from "@/components/ui/shimmer";

/**
 * The hero's placeholder — the ONE place the skeleton's hero geometry lives.
 * When the location hero changes shape (CurrentConditions), swap this file
 * only; LocationSkeleton just renders `<HeroSkeleton />`.
 *
 * Today it takes the box of CurrentConditions' sky plate (same padding and
 * flex column) but draws NO plate: calm bars straight on the page sky (the
 * cached hint's gradient, or a neutral one), never a saturated mineral slab,
 * so the skeleton is the same colour as the loaded page whatever the place
 * and theme. Every row carries the REAL text classes (font size, line height,
 * margins) around an `em`-sized bar, so each row is exactly as tall as the
 * text it stands in for and the hero does not change size when the content
 * arrives. Quiet bars only: no wordmark, no sentence, no spinner.
 */
export function HeroSkeleton() {
  return (
    <section aria-hidden="true" className="relative">
      <div
        data-skeleton="hero"
        className="relative z-10 flex flex-col items-center px-5 pt-7 pb-7 text-center text-text-secondary sm:px-8 sm:pt-9"
      >
        <p className="font-heading text-2xl font-semibold sm:text-3xl">
          <Shimmer className="h-[0.7em] w-40" />
        </p>
        <p className="mt-1 flex items-start justify-center leading-none tracking-tight">
          <span className="font-heading text-8xl font-semibold sm:text-9xl">
            <Shimmer className="h-[0.7em] w-[1.3em]" />
          </span>
        </p>
        <p className="mt-2 text-xl font-semibold sm:text-2xl">
          <Shimmer className="h-[0.7em] w-32" />
        </p>
        <p className="mt-1 text-lg font-medium">
          <Shimmer className="h-[0.7em] w-28" />
        </p>
        {/* No outlook rows: the hero's one-sentence outlook is read from the
            visitor's clock, so the server-rendered first paint (the box this
            skeleton stands in for) has none; it joins after hydration. */}
        {/* Sized by the real button's label (hidden, not drawn), so it wraps to
            two lines on a narrow phone exactly as the real one does. */}
        <Shimmer className="mt-4 flex min-h-[var(--touch-target-min)] items-center justify-center rounded-[var(--radius-button)] px-5 py-2.5 text-base font-semibold">
          <span className="invisible">Pick activities for tailored advice</span>
        </Shimmer>
        <Shimmer className="mt-3 block min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)] rounded-[var(--radius-button)] sm:w-24" />
      </div>
    </section>
  );
}
