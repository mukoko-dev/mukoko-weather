import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Generic skeleton placeholder for loading states.
 *
 * Renders a pulsing block that matches the shape/size of the content
 * it replaces. Use Tailwind classes for width, height, and border-radius.
 *
 * @example
 * <Skeleton className="h-4 w-32" />           // text line
 * <Skeleton className="h-10 w-full rounded-lg" /> // input
 * <Skeleton className="h-48 w-full rounded-xl" /> // card
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "animate-pulse rounded-md bg-text-tertiary/10",
        className
      )}
      {...props}
    />
  )
}

/** Card-shaped skeleton with header and content lines */
function CardSkeleton({ className, lines = 3 }: { className?: string; lines?: number }) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm sm:p-6",
        className
      )}
      role="status"
      aria-label="Loading"
    >
      {/* Title */}
      <Skeleton className="h-5 w-40 mb-3" />
      {/* Subtitle */}
      <Skeleton className="h-3 w-24 mb-4" />
      {/* Content lines */}
      <div className="space-y-2">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton
            key={i}
            className="h-3"
            style={{ width: `${85 - i * 10}%` }}
          />
        ))}
      </div>
    </div>
  )
}

/** Chart-shaped skeleton with matching aspect ratio */
function ChartSkeleton({ aspect = "aspect-[16/5]", className }: { aspect?: string; className?: string }) {
  return (
    <div
      className={cn(
        `${aspect} w-full animate-pulse rounded-[var(--radius-card)] bg-text-tertiary/10`,
        className
      )}
      role="status"
      aria-label="Loading chart"
    >
    </div>
  )
}

/** Badge-shaped skeleton */
function BadgeSkeleton({ className }: { className?: string }) {
  return (
    <Skeleton
      className={cn("h-5 w-16 rounded-[var(--radius-badge)]", className)}
    />
  )
}

/** Metric card skeleton (matches AtmosphericSummary MetricCard shape with arc gauge) */
function MetricCardSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm",
        className
      )}
      role="status"
      aria-label="Loading metric"
    >
      {/* Arc gauge placeholder */}
      <Skeleton className="h-14 w-14 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1">
        <Skeleton className="h-3 w-20 mb-1.5" />
        <Skeleton className="h-3 w-24" />
      </div>
    </div>
  )
}

/** Chat interface skeleton (matches ExploreChatbot container shape) */
function ChatSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-col h-full",
        className
      )}
      role="status"
      aria-label="Loading chat"
    >
      {/* Message area */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-8">
        <Skeleton className="h-12 w-12 rounded-full mb-4" />
        <Skeleton className="h-5 w-40 mb-2" />
        <Skeleton className="h-3 w-64 mb-1" />
        <Skeleton className="h-3 w-48 mb-6" />
        <div className="grid grid-cols-2 gap-2 w-full max-w-md">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-10 rounded-[var(--radius-card)]" />
          ))}
        </div>
      </div>
      {/* Input area */}
      <div className="shrink-0 border-t border-border px-4 py-3">
        <div className="flex gap-2">
          <Skeleton className="h-11 flex-1 rounded-md" />
          <Skeleton className="h-11 w-11 rounded-md" />
        </div>
      </div>
    </div>
  )
}

export {
  Skeleton,
  CardSkeleton,
  ChartSkeleton,
  BadgeSkeleton,
  MetricCardSkeleton,
  ChatSkeleton,
}
