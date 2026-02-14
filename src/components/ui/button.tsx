import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-red-600 text-white hover:bg-red-600/90",
        outline:
          "border border-border-default bg-transparent text-text-primary hover:bg-surface-card",
        secondary:
          "bg-surface-base text-text-secondary hover:text-text-primary hover:bg-surface-elevated",
        ghost:
          "text-text-secondary hover:bg-surface-base hover:text-text-primary",
        link:
          "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 rounded-[var(--radius-button)] px-4 py-2",
        sm: "h-8 rounded-[var(--radius-badge)] px-3 text-xs",
        lg: "h-12 rounded-[var(--radius-button)] px-6 py-3",
        icon: "h-10 w-10 rounded-full",
        "icon-lg": "h-11 w-11 rounded-full",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
