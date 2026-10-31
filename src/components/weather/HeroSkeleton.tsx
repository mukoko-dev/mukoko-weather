import { Shimmer } from "@/components/ui/shimmer";

/**
 * The hero's placeholder: the ONE place the skeleton's hero geometry lives.
 * When the location hero changes shape (CurrentConditions), change this file
 * only; LocationSkeleton just renders `<HeroSkeleton />`.
 *
 * It is the open-sky hero's box, row for row: the 48px top row (breadcrumb
 * bar at the left, round Share and, on phones, the round menu at the right),
 * then the centred stack (`pt-4 pb-[26px]`): eyebrow line (Caption), the name
 * (H2), the numeral (Display), the condition with its 20px glyph (H5) and the
 * H/L line (Body Large). Every row carries the REAL `--text-*` size and
 * leading around an `em`-sized bar, so each row is exactly as tall as the
 * text it stands in for and the hero does not change size when the content
 * arrives. No card, no plate: calm bars straight on the page sky (the same
 * `.kestrel` gradient the page paints). It carries `data-sky-hero`, so the
 * phone header is hidden exactly as the real hero hides it and loading does
 * not jump to loaded. Quiet bars only: no wordmark, no sentence, no spinner.
 */
export function HeroSkeleton() {
  return (
    <section
      aria-hidden="true"
      data-sky-hero
      data-skeleton="hero"
      className="relative text-[var(--sky-fg)]"
    >
      <div className="flex items-center justify-between gap-3 pt-1 pr-[env(safe-area-inset-right,0px)] pl-[env(safe-area-inset-left,0px)]">
        {/* The breadcrumb's box: a typical trail laid out invisibly (so it
            wraps on a narrow phone exactly as the real one does and the top
            row has the same height), with one quiet bar drawn over it. */}
        <div className="relative min-w-0 text-[length:var(--text-body-sm)] leading-[var(--text-body-sm-leading)]">
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
        <div className="flex shrink-0 items-center gap-2">
          <Shimmer className="size-[var(--touch-target-min)] rounded-full" />
          <Shimmer className="size-[var(--touch-target-min)] rounded-full sm:hidden" />
        </div>
      </div>
      <div className="flex flex-col items-center pt-4 pb-[26px] text-center">
        <p className="min-h-[calc(var(--text-caption)*var(--text-caption-leading))] text-[length:var(--text-caption)] leading-[var(--text-caption-leading)]">
          <Shimmer className="h-[0.7em] w-24" />
        </p>
        <p className="font-heading text-[length:var(--text-h2)] leading-[var(--text-h2-leading)] font-semibold">
          <Shimmer className="h-[0.7em] w-44" />
        </p>
        <p className="mt-1 font-sans text-[length:var(--text-display)] leading-[var(--text-display-leading)] font-normal">
          <Shimmer className="h-[0.7em] w-[1.6em]" />
        </p>
        <p className="mt-1 flex items-center justify-center gap-1.5 text-[length:var(--text-h5)] leading-[var(--text-h5-leading)] font-normal">
          <Shimmer className="size-5 shrink-0 rounded-full" />
          <span>
            <Shimmer className="h-[0.7em] w-28" />
          </span>
        </p>
        <p className="mt-1 text-[length:var(--text-body-lg)] leading-[var(--text-body-lg-leading)] font-semibold">
          <Shimmer className="h-[0.7em] w-32" />
        </p>
      </div>
    </section>
  );
}
