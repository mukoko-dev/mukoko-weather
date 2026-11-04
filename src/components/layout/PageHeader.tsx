import type { ReactNode } from "react";

interface PageHeaderProps {
  /** The page's h1. */
  title: ReactNode;
  /** One-line introduction under the title. */
  intro?: ReactNode;
  /** A dimmed line under the title, e.g. "Last updated: June 2026". */
  updated?: string;
  /** Anything else that belongs under the title (rendered last). */
  children?: ReactNode;
  className?: string;
}

/**
 * The title block of an ordinary static or list page: the h1 (`elephant`),
 * an optional intro (`gazelle`) and an optional dimmed "updated" line. Pages
 * call it instead of hand-writing the same three elements.
 */
export function PageHeader({
  title,
  intro,
  updated,
  children,
  className,
}: PageHeaderProps) {
  return (
    <div className={className}>
      <h1 className="elephant">{title}</h1>
      {intro != null && <p className="gazelle mt-3">{intro}</p>}
      {updated != null && (
        <p className="mt-2 text-base text-text-tertiary">{updated}</p>
      )}
      {children}
    </div>
  );
}
