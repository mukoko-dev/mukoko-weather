"use client";

/**
 * Mzizi Bottom Nav — vendored from the Mzizi registry
 * (`npx shadcn@latest add https://api.mzizi.dev/v1/ui/mzizi-bottom-nav`,
 * components/registry/n7-shell/mzizi-bottom-nav.tsx). Keep it in step with
 * upstream: behaviour changes go to mzizi-dev/mzizi-registry first.
 *
 * Local changes from upstream, each because the registry build cannot meet
 * a requirement of this app as published:
 *
 * 1. Items are `next/link` instead of a plain `<a>`. A plain anchor makes
 *    every tap a full document load (a new server render, a new Three.js
 *    backdrop, the whole JS bundle re-evaluated), which is exactly the
 *    slow-load the v0.10.0 fix removes.
 * 2. The active item carries `aria-current="page"` (upstream marks it only
 *    visually).
 * 3. Items are at least `--touch-target-min` (48px) tall. Upstream items are
 *    `py-1` + a 21px icon + a 10px label, about 47px. Here the icon is 18px
 *    and the label 14px, so the item is about 51px, and its tappable area
 *    (`.plover`, globals.css) runs the bar's whole height.
 * 4. (Superseded by 9.) Upstream's `h-20` bar left only 46px for the 48px
 *    items on an iPhone.
 * 5. An optional `label` (the landmark's aria-label).
 * 6. Icons come from lucide-react (this app has no `@/lib/icons` shim). The
 *    upstream literal colour fallbacks (a hex blue and an rgba glow) are dropped for
 *    the `--color-primary` token and `shadow-md`, since this repo forbids
 *    literal colours in components. This app passes no FAB item.
 * 7. Hidden from `md` up as upstream; this app also passes `sm:hidden`,
 *    because its desktop header nav takes over from `sm`.
 *
 * 8. Labels use this repo's `--text-nav-label` token (0.875rem, the Mzizi
 *    body-sm size). Upstream's 10px label is too small to read comfortably;
 *    16px (this token's value until 2026-11-04) read as out of proportion
 *    in the bar.
 *
 * 9. FLOATING, not docked (owner decision 2026-10-17, mukoko-news is the
 *    source of truth: src/components/layout/bottom-nav.tsx there). The bar is
 *    no longer `inset-x-0 bottom-0` with a top border; it is a pill inset 1rem
 *    from both screen edges (`left-4 right-4 mx-auto max-w-md`), lifted
 *    `--mobile-nav-inset` plus the safe-area inset off the bottom,
 *    `--mobile-nav-bar-height` tall (4.5rem; 4rem until 2026-11-04),
 *    `rounded-full`, a solid 0.5px token
 *    border (`--border-width-rest`), `shadow-lg` and `backdrop-blur-xl` on a
 *    translucent card surface. A floating bar clears the browser toolbar and
 *    the home-indicator gesture zone, which a full-width bar welded to the
 *    viewport does not. Upstream's `5rem + safe area` height (change 4) and
 *    `pb-[env(safe-area-inset-bottom)]` are gone: the lift carries the inset.
 *    The `<nav>` landmark IS that pill (one element, one surface).
 * 10. A LANE between pinned items (owner decision 2026-11-02, option B: one
 *    bar instead of a bar plus a pager pill above it). New optional slots,
 *    mutually exclusive with `items` (the props are a union, so TypeScript
 *    refuses a mix):
 *      - `leading`  pinned items at the start edge,
 *      - `lane`     a node in the middle that takes all the remaining width
 *                   (`flex-1 min-w-0`, so it may shrink and scroll),
 *      - `trailing` pinned items at the end edge.
 *    The component owns the layout only (pinned items never shrink, the lane
 *    does); what scrolls, snaps or fades inside the lane is the consumer's
 *    (this app: components/layout/PlaceLane.tsx, which also keeps its own
 *    first chip pinned and its current chip in view). With a lane the pinned
 *    items are as narrow as a touch target allows (`min-w` 48px, `px-2`, not
 *    60px and `px-3`) and their labels collapse to screen-reader-only below
 *    360px, so the lane keeps the width on a small phone; the bar uses
 *    `gap-2` between its parts. Pinned items stay pill-sized (about 51px) and
 *    take `.plover`, so the whole bar height is their tappable area, and their
 *    icon is 18px. Without `lane` the bar is exactly the registry's single
 *    `items` row.
 *    This replaces the earlier `indicator` pill (a second floating pill one
 *    touch target tall above the bar, with a `--mobile-nav-gap` between): the
 *    bar is now the only floating surface and both are gone.
 *
 * `--mobile-nav-clearance` in globals.css is the bar (4.5rem) plus the lift,
 * the safe area and a breath, so page content always matches the one bar.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";

export interface BottomNavItem {
  /** Unique identifier */
  id: string;
  /** Display label */
  label: string;
  /** Route path */
  href: string;
  /** Default icon */
  icon: React.ComponentType<{ className?: string }>;
  /** Active state icon (optional, falls back to icon) */
  activeIcon?: React.ComponentType<{ className?: string }>;
  /** Whether this item is the center FAB */
  isFab?: boolean;
  /** FAB click handler (overrides href for FAB items) */
  onFabClick?: () => void;
  /** Accessible name when it should say more than the visible label. */
  ariaLabel?: string;
}

/**
 * What the bar shows: either the registry's single row of `items`, or pinned
 * `leading` and `trailing` items around a `lane` (local addition 10).
 */
type MziziBottomNavLayout =
  | {
      items: BottomNavItem[];
      leading?: undefined;
      lane?: undefined;
      trailing?: undefined;
    }
  | {
      items?: undefined;
      /** Pinned at the start edge, before the lane. */
      leading?: BottomNavItem[];
      /** The middle: takes the remaining width and may scroll (local addition). */
      lane: React.ReactNode;
      /** Pinned at the end edge, after the lane. */
      trailing?: BottomNavItem[];
    };

type MziziBottomNavProps = MziziBottomNavLayout & {
  /** Override active detection (useful for client-side routing) */
  activeId?: string;
  className?: string;
  /** Landmark label (local addition). */
  label?: string;
};

/** Upstream active-item rule: `/` matches only exactly, others by prefix. */
export function isBottomNavItemActive(
  item: Pick<BottomNavItem, "id" | "href">,
  pathname: string,
  activeId?: string,
): boolean {
  if (activeId) return activeId === item.id;
  if (item.href === "/") return pathname === "/";
  return pathname === item.href || pathname.startsWith(item.href + "/");
}

/**
 * The floating pill surface: pill radius, a solid 0.5px border on all four
 * sides (the Mzizi border rule), lifted shadow, translucent card fill with
 * blur (mukoko-news island).
 */
const FLOATING_SURFACE =
  "rounded-full border-solid border-border border-[length:var(--border-width-rest)] bg-card/90 shadow-lg backdrop-blur-xl";

export function MziziBottomNav({
  items,
  leading,
  lane,
  trailing,
  activeId,
  className,
  label,
}: MziziBottomNavProps) {
  const pathname = usePathname() ?? "";
  // The props are a union: `items` (the registry row) or a lane layout.
  const hasLane = items === undefined;

  function renderItem(item: BottomNavItem) {
    const active = isBottomNavItemActive(item, pathname, activeId);

    /* ── Center FAB ───────────────────────────────────────── */
    if (item.isFab) {
      return (
        <button
          key={item.id}
          type="button"
          onClick={item.onFabClick}
          aria-label={item.ariaLabel ?? item.label}
          className={cn(
            "flex size-[52px] -translate-y-6 items-center justify-center rounded-full",
            "bg-[var(--brand-accent,var(--color-primary))] shadow-md",
            "transition-transform active:scale-95",
          )}
        >
          <Plus className="size-[26px] text-background" strokeWidth={2.5} />
        </button>
      );
    }

    /* ── Standard nav item ────────────────────────────────── */
    const Icon = active && item.activeIcon ? item.activeIcon : item.icon;
    return (
      <Link
        key={item.id}
        href={item.href}
        prefetch={false}
        aria-current={active ? "page" : undefined}
        aria-label={item.ariaLabel}
        className={cn(
          "plover relative flex min-h-[var(--touch-target-min)] flex-col items-center justify-center gap-1 rounded-full py-1",
          hasLane
            ? "min-w-[var(--touch-target-min)] shrink-0 px-2"
            : "min-w-[60px] px-3",
          "text-[length:var(--text-nav-label)] font-medium transition-colors",
          active
            ? "text-[var(--brand-accent,var(--color-primary))]"
            : "text-muted-foreground",
        )}
      >
        {/* Active top accent bar — brand identity marker. Anchored to the
            BAR's top edge (the item is centred in a taller bar), 1px inside
            it, so it does not depend on how tall the item happens to be. */}
        {active && (
          <span
            aria-hidden="true"
            className="absolute top-[calc((100%_-_var(--mobile-nav-bar-height))_/_2_+_1px)] h-[2.5px] w-7 rounded-full bg-[var(--brand-accent,var(--color-primary))]"
          />
        )}
        <Icon
          className={cn(
            "size-[18px]",
            active ? "stroke-[2.2]" : "stroke-[1.8]",
          )}
        />
        {/* Below 360px a lane needs the width more than the label does; the
            accessible name stays (`ariaLabel`, else this text). */}
        <span className={hasLane ? "max-[359px]:sr-only" : undefined}>
          {item.label}
        </span>
      </Link>
    );
  }

  return (
    <nav
      data-slot="mzizi-bottom-nav"
      data-portal="https://mzizi.dev/components/mzizi-bottom-nav"
      aria-label={label}
      className={cn(
        "fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom,0px)+var(--mobile-nav-inset))] z-50 mx-auto flex h-[var(--mobile-nav-bar-height)] max-w-md items-center md:hidden",
        FLOATING_SURFACE,
        hasLane ? "gap-2 px-2" : "justify-around px-2",
        "[&_a]:focus-visible:outline-2 [&_a]:focus-visible:outline-offset-2 [&_a]:focus-visible:outline-primary [&_button]:focus-visible:outline-2 [&_button]:focus-visible:outline-offset-2 [&_button]:focus-visible:outline-primary",
        className,
      )}
    >
      {items ? (
        items.map(renderItem)
      ) : (
        <>
          {leading?.map(renderItem)}
          <div
            data-slot="mzizi-bottom-nav-lane"
            className="flex h-full min-w-0 flex-1 items-center"
          >
            {lane}
          </div>
          {trailing?.map(renderItem)}
        </>
      )}
    </nav>
  );
}
