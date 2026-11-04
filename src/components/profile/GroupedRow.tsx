/**
 * One row of a profile group (`.guineafowl-row`): icon, label, an optional
 * muted value, and a chevron. Renders a link when `href` is set, otherwise a
 * button calling `onClick`. `tone="danger"` colours the row for destructive
 * actions and drops the chevron unless asked for.
 */

import Link from "next/link";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface GroupedRowBase {
  icon: LucideIcon;
  label: string;
  /** Muted text on the right, before the chevron. */
  value?: string;
  /** Extra words for screen readers only. */
  description?: string;
  tone?: "default" | "danger";
  /** Defaults to true for navigation; pass false for a one-shot action. */
  chevron?: boolean;
}

export type GroupedRowProps =
  | (GroupedRowBase & { href: string; prefetch?: boolean; onClick?: never })
  | (GroupedRowBase & { onClick: () => void; href?: never; prefetch?: never });

export function GroupedRow({
  icon: Icon,
  label,
  value,
  description,
  tone = "default",
  chevron = true,
  href,
  prefetch,
  onClick,
}: GroupedRowProps) {
  const content = (
    <>
      <span className="flex min-w-0 items-center gap-3">
        <Icon
          className={cn(
            "h-5 w-5 shrink-0",
            tone === "default" && "text-text-secondary",
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 truncate">{label}</span>
        {description && <span className="sr-only">{description}</span>}
      </span>
      {(value !== undefined || chevron) && (
        <span className="flex shrink-0 items-center gap-2 text-text-tertiary">
          {value !== undefined && <span className="text-sm">{value}</span>}
          {chevron && <ChevronRight className="h-4 w-4" aria-hidden="true" />}
        </span>
      )}
    </>
  );

  const className = cn(
    "guineafowl-row",
    tone === "danger" && "text-severity-severe",
  );

  if (href !== undefined) {
    return (
      <Link href={href} prefetch={prefetch} className={className}>
        {content}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={className}>
      {content}
    </button>
  );
}
