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
 *    `py-1` + a 21px icon + a 10px label, about 47px.
 * 4. (Superseded by 9.) Upstream's `h-20` bar left only 46px for the 48px
 *    items on an iPhone.
 * 5. An optional `label` (the landmark's aria-label) and `indicator`: a row
 *    one touch target tall directly above the items, on the bar's own
 *    surface (this app puts the location pager there — tappable dots).
 * 6. Icons come from lucide-react (this app has no `@/lib/icons` shim). The
 *    upstream literal colour fallbacks (a hex blue and an rgba glow) are dropped for
 *    the `--color-primary` token and `shadow-md`, since this repo forbids
 *    literal colours in components. This app passes no FAB item.
 * 7. Hidden from `md` up as upstream; this app also passes `sm:hidden`,
 *    because its desktop header nav takes over from `sm`.
 *
 * 8. Labels use this repo's `--text-nav-label` token (1rem). Upstream's
 *    10px label size is under this app's hard 16px minimum font size.
 *
 * 9. FLOATING, not docked (owner decision 2026-10-17, mukoko-news is the
 *    source of truth: src/components/layout/bottom-nav.tsx there). The bar is
 *    no longer `inset-x-0 bottom-0` with a top border; it is a pill inset 1rem
 *    from both screen edges (`left-4 right-4 mx-auto max-w-md`), lifted
 *    `--mobile-nav-inset` plus the safe-area inset off the bottom, `4rem`
 *    tall (`--mobile-nav-bar-height`), `rounded-full`, a solid 0.5px token
 *    border (`--border-width-rest`), `shadow-lg` and `backdrop-blur-xl` on a
 *    translucent card surface. A floating bar clears the browser toolbar and
 *    the home-indicator gesture zone, which a full-width bar welded to the
 *    viewport does not. Upstream's `5rem + safe area` height (change 4) and
 *    `pb-[env(safe-area-inset-bottom)]` are gone: the lift carries the inset.
 * 10. The `indicator` row is its own small floating pill, one touch target
 *    tall and `--mobile-nav-gap` above the bar (a two-row pill would stop
 *    being a pill). The `<nav>` landmark is the transparent fixed wrapper
 *    for both and lets taps through between them (`pointer-events-none`).
 *
 * `--mobile-nav-height` in globals.css is the bar (4rem) + the gap + the
 * indicator pill (one touch target), without the lift or the safe area, so
 * `--mobile-nav-clearance` always matches it.
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

interface MziziBottomNavProps {
  items: BottomNavItem[];
  /** Override active detection (useful for client-side routing) */
  activeId?: string;
  className?: string;
  /** Landmark label (local addition). */
  label?: string;
  /** Decorative row along the bottom edge of the bar (local addition). */
  indicator?: React.ReactNode;
}

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
 * The floating pill surface, shared by the bar and the indicator pill:
 * pill radius, a solid 0.5px border on all four sides (the Mzizi border
 * rule), lifted shadow, translucent card fill with blur (mukoko-news island).
 */
const FLOATING_SURFACE =
  "pointer-events-auto rounded-full border-solid border-border border-[length:var(--border-width-rest)] bg-card/90 shadow-lg backdrop-blur-xl";

export function MziziBottomNav({
  items,
  activeId,
  className,
  label,
  indicator,
}: MziziBottomNavProps) {
  const pathname = usePathname() ?? "";

  return (
    <nav
      data-slot="mzizi-bottom-nav"
      data-portal="https://mzizi.dev/components/mzizi-bottom-nav"
      aria-label={label}
      className={cn(
        "pointer-events-none fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom,0px)+var(--mobile-nav-inset))] z-50 mx-auto flex max-w-md flex-col items-center gap-[var(--mobile-nav-gap)] md:hidden",
        className,
      )}
    >
      {indicator && (
        <div
          data-slot="mzizi-bottom-nav-indicator"
          className={cn(
            FLOATING_SURFACE,
            "flex h-[var(--touch-target-min)] max-w-full items-center px-2",
          )}
        >
          {indicator}
        </div>
      )}
      <div
        data-slot="mzizi-bottom-nav-bar"
        className={cn(
          FLOATING_SURFACE,
          "flex h-[var(--mobile-nav-bar-height)] w-full items-center justify-around px-2 [&_a]:focus-visible:outline-2 [&_a]:focus-visible:outline-offset-2 [&_a]:focus-visible:outline-primary [&_button]:focus-visible:outline-2 [&_button]:focus-visible:outline-offset-2 [&_button]:focus-visible:outline-primary",
        )}
      >
        {items.map((item) => {
          const active = isBottomNavItemActive(item, pathname, activeId);

          /* ── Center FAB ─────────────────────────────────────── */
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
                <Plus
                  className="size-[26px] text-background"
                  strokeWidth={2.5}
                />
              </button>
            );
          }

          /* ── Standard nav item ──────────────────────────────── */
          const Icon = active && item.activeIcon ? item.activeIcon : item.icon;
          return (
            <Link
              key={item.id}
              href={item.href}
              prefetch={false}
              aria-current={active ? "page" : undefined}
              aria-label={item.ariaLabel}
              className={cn(
                "relative flex min-h-[var(--touch-target-min)] min-w-[60px] flex-col items-center justify-center gap-[3px] rounded-full px-3 py-1",
                "text-[length:var(--text-nav-label)] font-medium transition-colors",
                active
                  ? "text-[var(--brand-accent,var(--color-primary))]"
                  : "text-muted-foreground",
              )}
            >
              {/* Active top accent bar — brand identity marker */}
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute -top-[3px] h-[2.5px] w-7 rounded-full bg-[var(--brand-accent,var(--color-primary))]"
                />
              )}
              <Icon
                className={cn(
                  "size-[21px]",
                  active ? "stroke-[2.2]" : "stroke-[1.8]",
                )}
              />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
