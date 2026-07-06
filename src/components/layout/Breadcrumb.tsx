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
