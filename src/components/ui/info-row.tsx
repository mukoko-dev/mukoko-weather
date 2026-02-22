import * as React from "react"

import { cn } from "@/lib/utils"

interface InfoRowProps extends React.ComponentProps<"div"> {
  /** Label text (left side) */
  label: string
  /** Value content (right side) — string or ReactNode */
  value: React.ReactNode
}

function InfoRow({ className, label, value, ...props }: InfoRowProps) {
  return (
    <div
      data-slot="info-row"
      className={cn("flex justify-between gap-2", className)}
      {...props}
    >
      <dt className="text-text-secondary">{label}</dt>
      <dd className="text-right font-medium text-text-primary">{value}</dd>
    </div>
  )
}

export { InfoRow, type InfoRowProps }
