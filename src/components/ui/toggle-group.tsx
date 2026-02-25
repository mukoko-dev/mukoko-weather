"use client"

import * as React from "react"
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const toggleGroupItemVariants = cva(
  "inline-flex items-center justify-center text-base font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "shrink-0 rounded-[var(--radius-badge)] px-4 py-2 min-h-[44px] data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=off]:bg-surface-base data-[state=off]:text-text-secondary data-[state=off]:hover:text-text-primary",
        outline:
          "shrink-0 rounded-[var(--radius-badge)] border-2 px-4 py-2 min-h-[44px] data-[state=on]:border-primary data-[state=on]:bg-primary/5 data-[state=on]:text-primary data-[state=off]:border-transparent data-[state=off]:bg-surface-base data-[state=off]:text-text-secondary data-[state=off]:hover:text-text-primary",
        /** Use "unstyled" when items need fully custom active/inactive styling (e.g. per-item mineral colors). */
        unstyled: "shrink-0",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)

type ToggleGroupContextValue = VariantProps<typeof toggleGroupItemVariants>

const ToggleGroupContext = React.createContext<ToggleGroupContextValue>({
  variant: "default",
})

function ToggleGroup({
  className,
  variant,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> &
  VariantProps<typeof toggleGroupItemVariants>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn("flex items-center gap-1.5", className)}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ variant }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  )
}

function ToggleGroupItem({
  className,
  variant,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> &
  VariantProps<typeof toggleGroupItemVariants>) {
  const context = React.useContext(ToggleGroupContext)

  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        toggleGroupItemVariants({ variant: variant ?? context.variant }),
        className,
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  )
}

export { ToggleGroup, ToggleGroupItem, toggleGroupItemVariants }
