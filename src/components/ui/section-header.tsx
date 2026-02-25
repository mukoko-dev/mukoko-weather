import * as React from "react"
import Link from "next/link"

import { cn } from "@/lib/utils"

interface SectionHeaderAction {
  label: string
  href?: string
  onClick?: () => void
}

interface SectionHeaderProps extends React.ComponentProps<"div"> {
  /** Heading ID for aria-labelledby */
  headingId?: string
  /** Section title */
  title: string
  /** Heading level — renders as h2 by default */
  as?: "h2" | "h3" | "h4"
  /** Optional action link or button on the right */
  action?: SectionHeaderAction
}

function SectionHeader({
  className,
  headingId,
  title,
  as: Tag = "h2",
  action,
  ...props
}: SectionHeaderProps) {
  return (
    <div
      data-slot="section-header"
      className={cn("flex items-center justify-between gap-2", className)}
      {...props}
    >
      <Tag id={headingId} className="text-base font-semibold text-text-primary font-heading">
        {title}
      </Tag>
      {action && (
        action.href ? (
          <Link
            href={action.href}
            className="text-base font-medium text-primary transition-colors hover:text-primary/80 min-h-[var(--touch-target-min)]"
          >
            {action.label}
          </Link>
        ) : (
          <button
            onClick={action.onClick}
            type="button"
            className="text-base font-medium text-primary transition-colors hover:text-primary/80 min-h-[var(--touch-target-min)]"
          >
            {action.label}
          </button>
        )
      )}
    </div>
  )
}

export { SectionHeader, type SectionHeaderProps, type SectionHeaderAction }
