import { Fragment } from "react";
import Link from "next/link";

export interface BreadcrumbItem {
  label: string;
  /** Omit for the current page — rendered as plain text with aria-current="page" */
  href?: string;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
  className?: string;
}

/**
 * Shared breadcrumb trail for location sub-routes (atmosphere, forecast,
 * map). Centralizes the Home / Location / Current-page pattern previously
 * hand-rolled separately in each sub-route dashboard.
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
      className={["mx-auto max-w-5xl px-4 pt-4 sm:px-6 md:px-8", className]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex items-center gap-1">
        <div className="h-3 w-10 animate-pulse rounded bg-text-tertiary/15" />
        <span aria-hidden="true" className="text-text-tertiary/30">/</span>
        <div className="h-3 w-14 animate-pulse rounded bg-text-tertiary/15" />
        <span aria-hidden="true" className="text-text-tertiary/30">/</span>
        <div className="h-3 w-16 animate-pulse rounded bg-text-tertiary/15" />
      </div>
    </div>
  );
}

export function Breadcrumb({ items, className }: BreadcrumbProps) {
  return (
    <nav
      aria-label="Breadcrumb"
      className={["mx-auto max-w-5xl px-4 pt-4 sm:px-6 md:px-8", className]
        .filter(Boolean)
        .join(" ")}
    >
      <ol className="flex items-center gap-1 text-base text-text-tertiary">
        {items.map((item, i) => (
          <Fragment key={item.label}>
            {i > 0 && <li aria-hidden="true">/</li>}
            <li aria-current={item.href ? undefined : "page"}>
              {item.href ? (
                <Link
                  href={item.href}
                  className="hover:text-text-secondary transition-colors focus-visible:outline-2 focus-visible:outline-primary focus-visible:rounded"
                >
                  {item.label}
                </Link>
              ) : (
                <span className="font-medium text-text-primary">{item.label}</span>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}
