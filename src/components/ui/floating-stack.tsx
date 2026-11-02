import type { ReactNode } from "react";

/**
 * The surface of a card that floats above the mobile nav: the home page's
 * location ask (`LocationPromptCard`) and the weather-load notice
 * (`PlaceLoadNotice`). One class chain, so the two cannot drift apart.
 */
export const FLOATING_CARD_CLASS =
  "animate-fade-in-up rounded-[var(--radius-card)] border border-primary/25 bg-surface-card/95 p-3 shadow-lg backdrop-blur-xl";

/**
 * Where floating cards sit: ONE fixed column above the mobile nav (the bottom
 * edge on `sm` and up, where the nav is hidden). Cards are in the column, not
 * fixed themselves, so two shown at once stack instead of lying on top of each
 * other, hiding a button. The first child is the lowest (nearest the thumb);
 * the column is only as tall as its cards, so it never blocks the page.
 */
export function FloatingStack({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-x-3 bottom-[var(--mobile-nav-clearance)] z-30 mx-auto flex max-w-md flex-col-reverse gap-2 sm:bottom-6">
      {children}
    </div>
  );
}
