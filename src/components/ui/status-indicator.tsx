import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Status types
// ---------------------------------------------------------------------------

type ServiceStatus = "operational" | "degraded" | "down"

// ---------------------------------------------------------------------------
// StatusDot — small colored circle (used in service check rows)
// ---------------------------------------------------------------------------

const statusDotVariants = cva(
  "inline-flex shrink-0 rounded-full",
  {
    variants: {
      status: {
        operational: "bg-severity-low",
        degraded: "bg-severity-moderate",
        down: "bg-severity-severe",
      },
      size: {
        sm: "h-2 w-2",
        default: "h-3 w-3",
        lg: "h-4 w-4",
      },
    },
    defaultVariants: {
      status: "operational",
      size: "default",
    },
  },
)

function StatusDot({
  className,
  status,
  size,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof statusDotVariants> & { status: ServiceStatus }) {
  const label =
    status === "operational" ? "Operational" :
    status === "degraded" ? "Degraded" : "Down"

  return (
    <span
      data-slot="status-dot"
      aria-label={label}
      className={cn(statusDotVariants({ status, size }), className)}
      {...props}
    />
  )
}

// ---------------------------------------------------------------------------
// StatusBadge — pill with status text + border
// ---------------------------------------------------------------------------

const statusBadgeStyles: Record<ServiceStatus, string> = {
  operational: "bg-severity-low/10 text-severity-low border-severity-low/20",
  degraded: "bg-severity-moderate/10 text-severity-moderate border-severity-moderate/20",
  down: "bg-severity-severe/10 text-severity-severe border-severity-severe/20",
}

function StatusBadge({
  className,
  status,
  ...props
}: React.ComponentProps<"span"> & { status: ServiceStatus }) {
  return (
    <span
      data-slot="status-badge"
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize",
        statusBadgeStyles[status],
        className,
      )}
      {...props}
    >
      {status}
    </span>
  )
}

export {
  StatusDot,
  StatusBadge,
  statusDotVariants,
  type ServiceStatus,
}
