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
 * 4. The bar is `5rem` PLUS the safe-area inset tall. Upstream is `h-20`
 *    with `pb-[env(safe-area-inset-bottom)]` inside it, so on an iPhone
 *    (34px inset) only 46px is left for the 48px items.
 * 5. An optional `label` (the landmark's aria-label) and `indicator` (a
 *    decorative row painted along the bottom edge of the bar, above the
 *    safe area — this app uses it for the location page dots).
 * 6. Icons come from lucide-react (this app has no `@/lib/icons` shim). The
 *    upstream literal colour fallbacks (a hex blue and an rgba glow) are dropped for
 *    the `--color-primary` token and `shadow-md`, since this repo forbids
 *    literal colours in components. This app passes no FAB item.
 * 7. Hidden from `md` up as upstream; this app also passes `sm:hidden`,
 *    because its desktop header nav takes over from `sm`.
 *
 * `--mobile-nav-height` in globals.css is this bar's height without the
 * safe area (5rem), so `--mobile-nav-clearance` always matches it.
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
        "fixed inset-x-0 bottom-0 z-50 flex h-[calc(5rem+env(safe-area-inset-bottom,0px))] items-center justify-around",
        "border-t border-border bg-card/90 backdrop-blur-xl",
        "pb-[env(safe-area-inset-bottom)] md:hidden [&_a]:focus-visible:outline-2 [&_a]:focus-visible:outline-offset-2 [&_a]:focus-visible:outline-primary [&_button]:focus-visible:outline-2 [&_button]:focus-visible:outline-offset-2 [&_button]:focus-visible:outline-primary",
        className,
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
              <Plus className="size-[26px] text-background" strokeWidth={2.5} />
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
              "relative flex min-h-[var(--touch-target-min)] min-w-[56px] flex-col items-center justify-center gap-[3px] py-1",
              "text-[10px] font-medium transition-colors",
              active
                ? "text-[var(--brand-accent,var(--color-primary))]"
                : "text-muted-foreground",
            )}
          >
            {/* Active top accent bar — brand identity marker */}
            {active && (
              <span
                aria-hidden="true"
                className="absolute -top-[9px] h-[2.5px] w-7 rounded-full bg-[var(--brand-accent,var(--color-primary))]"
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
      {indicator && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[calc(env(safe-area-inset-bottom,0px)+0.375rem)] flex justify-center">
          {indicator}
        </div>
      )}
    </nav>
  );
}
