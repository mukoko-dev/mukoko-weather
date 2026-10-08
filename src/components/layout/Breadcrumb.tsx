import { Fragment } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

export interface BreadcrumbItem {
  label: string;
  /** Link target. Omit for non-link items. */
  href?: string;
  /**
   * Non-link item that is NOT the current page — plain secondary text with
   * no aria-current. Only meaningful when `href` is omitted.
   */
  plain?: boolean;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
  className?: string;
  /**
   * "page" (default): the inline trail under the header.
   * "overlay": a compact single-line pill for full-screen surfaces (the
   * weather map) — solid card surface so it reads over map tiles in light
   * and dark, touch-target-min tall links, long names truncate instead of
   * wrapping into the controls beside it.
   */
  variant?: "page" | "overlay";
}

/**
 * Shared breadcrumb trail for location sub-routes (atmosphere, forecast,
 * map) and the explore pages. Centralizes the Home / Location / Current-page
 * pattern previously hand-rolled separately in each page.
 *
 * An item with no `href` and no `plain` flag is the current page: rendered as
 * emphasised text with aria-current="page".
 */
/**
 * Loading placeholder matching the 3-segment Breadcrumb trail — same outer
 * container classes as the real component so there's no layout shift when the
 * page hydrates. Used by the atmosphere/forecast/map loading.tsx files, which
 * previously each hand-rolled an identical skeleton block.
 */
export function BreadcrumbSkeleton({ className }: { className?: string }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn("mx-auto max-w-5xl px-4 pt-4 sm:px-6 md:px-8", className)}
    >
      <div className="flex items-center gap-1">
        <div className="h-3 w-10 animate-pulse rounded bg-text-tertiary/15" />
        <span aria-hidden="true" className="text-text-tertiary/30">
          /
        </span>
        <div className="h-3 w-14 animate-pulse rounded bg-text-tertiary/15" />
        <span aria-hidden="true" className="text-text-tertiary/30">
          /
        </span>
        <div className="h-3 w-16 animate-pulse rounded bg-text-tertiary/15" />
      </div>
    </div>
  );
}

export function Breadcrumb({
  items,
  className,
  variant = "page",
}: BreadcrumbProps) {
  if (variant === "overlay") {
    return (
      <nav
        aria-label="Breadcrumb"
        className={cn(
          "pointer-events-auto flex min-w-0 max-w-full items-center rounded-full bg-surface-card px-3 shadow-md ring-1 ring-border",
          className,
        )}
      >
        <ol className="flex min-w-0 flex-nowrap items-center gap-1 text-sm text-text-tertiary">
          {items.map((item, i) => {
            const isCurrent = !item.href && !item.plain;
            const isLast = i === items.length - 1;
            return (
              <Fragment key={item.label}>
                {i > 0 && (
                  <li aria-hidden="true" className="shrink-0">
                    /
                  </li>
                )}
                <li
                  aria-current={isCurrent ? "page" : undefined}
                  className={cn("min-w-0", isLast && "shrink-0")}
                >
                  {item.href ? (
                    <Link
                      href={item.href}
                      className="flex min-h-[var(--touch-target-min)] min-w-0 items-center truncate transition-colors hover:text-text-secondary focus-visible:rounded focus-visible:outline-2 focus-visible:outline-primary"
                    >
                      <span className="truncate">{item.label}</span>
                    </Link>
                  ) : (
                    <span
                      className={cn(
                        "flex min-h-[var(--touch-target-min)] items-center",
                        isCurrent
                          ? "font-medium text-text-primary"
                          : "text-text-secondary",
                      )}
                    >
                      {item.label}
                    </span>
                  )}
                </li>
              </Fragment>
            );
          })}
        </ol>
      </nav>
    );
  }

  return (
    <nav
      aria-label="Breadcrumb"
      className={cn("mx-auto max-w-5xl px-4 pt-4 sm:px-6 md:px-8", className)}
    >
      <ol className="flex flex-wrap items-center gap-1 text-base text-text-tertiary">
        {items.map((item, i) => {
          const isCurrent = !item.href && !item.plain;
          return (
            <Fragment key={item.label}>
              {i > 0 && <li aria-hidden="true">/</li>}
              <li aria-current={isCurrent ? "page" : undefined}>
                {item.href ? (
                  <Link
                    href={item.href}
                    className="dik-dik hover:text-text-secondary transition-colors focus-visible:outline-2 focus-visible:outline-primary focus-visible:rounded"
                  >
                    {item.label}
                  </Link>
                ) : isCurrent ? (
                  <span className="font-medium text-text-primary">
                    {item.label}
                  </span>
                ) : (
                  <span className="text-text-secondary">{item.label}</span>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
