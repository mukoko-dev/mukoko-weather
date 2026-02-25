import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// CTACard — call-to-action card with title, description, and action slot
// ---------------------------------------------------------------------------

const ctaCardVariants = cva(
  "rounded-[var(--radius-card)] p-5 shadow-sm sm:p-6",
  {
    variants: {
      variant: {
        default: "bg-surface-card",
        accent: "border border-primary/20 bg-primary/5",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)

interface CTACardProps
  extends React.ComponentProps<"div">,
    VariantProps<typeof ctaCardVariants> {
  /** Card title */
  title: string
  /** Card description */
  description: string
  /** Heading level — defaults to h3 */
  as?: "h2" | "h3" | "h4"
  /** Action slot rendered on the right side */
  action: React.ReactNode
}

function CTACard({
  className,
  variant,
  title,
  description,
  as: Heading = "h3",
  action,
  ...props
}: CTACardProps) {
  return (
    <div
      data-slot="cta-card"
      className={cn(ctaCardVariants({ variant }), className)}
      {...props}
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <Heading className="text-base font-semibold text-text-primary font-heading">
            {title}
          </Heading>
          <p className="mt-1.5 text-base text-text-secondary leading-relaxed">{description}</p>
        </div>
        {action}
      </div>
    </div>
  )
}

export { CTACard, ctaCardVariants, type CTACardProps }
