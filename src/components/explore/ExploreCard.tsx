import type { ReactNode } from "react";
import Link from "next/link";

import { cn } from "@/lib/utils";

interface ExploreCardProps {
  href: string;
  /** The card's name. Rendered as a heading when `as` is given. */
  title: ReactNode;
  as?: "h2" | "h3";
  /** A secondary line under the title (e.g. elevation). */
  meta?: ReactNode;
  /** Short pill or count shown at the top right, beside the title. */
  badge?: ReactNode;
  /** Anything else (e.g. a description). */
  children?: ReactNode;
  className?: string;
}

/**
 * The one link card for a location, province, country or category on the
 * explore pages: a baobab surface, title with an optional badge, and optional
 * meta and body lines.
 */
export function ExploreCard({
  href,
  title,
  as,
  meta,
  badge,
  children,
  className,
}: ExploreCardProps) {
  const Heading = as;
  return (
    <Link
      href={href}
      className={cn(
        "group card-interactive baobab flex min-w-0 flex-col",
        className,
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        {Heading ? (
          <Heading className="giraffe min-w-0 transition-colors group-hover:text-primary">
            {title}
          </Heading>
        ) : (
          <span className="min-w-0 truncate font-medium text-text-primary transition-colors group-hover:text-primary">
            {title}
          </span>
        )}
        {badge}
      </div>
      {meta != null && (
        <p className="mt-1 text-base text-text-tertiary">{meta}</p>
      )}
      {children}
    </Link>
  );
}
