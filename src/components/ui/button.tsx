import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-base font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-white hover:bg-destructive/90",
        outline:
          "border border-border bg-transparent text-text-primary hover:bg-surface-card",
        secondary:
          "bg-surface-base text-text-secondary hover:text-text-primary hover:bg-surface-elevated",
        ghost:
          "text-text-secondary hover:bg-surface-base hover:text-text-primary",
        link: "text-primary underline-offset-4 hover:underline",
      },
      /* Mzizi Button contract (mzizi.dev/components/button): every size is
         a pill (rounded-full via --radius-button); 56px default, 48px `sm`
         (the touch-target floor, --touch-target-min), never smaller. */
      size: {
        default:
          "h-14 min-h-[var(--touch-target-min)] rounded-[var(--radius-button)] px-5",
        sm: "h-12 min-h-[var(--touch-target-min)] rounded-[var(--radius-button)] px-4 text-base",
        lg: "h-14 min-h-[var(--touch-target-min)] rounded-[var(--radius-button)] px-6",
        icon: "size-14 rounded-full",
        "icon-sm": "size-12 rounded-full",
        /** Legacy alias of `icon` (56px square). */
        "icon-lg": "size-14 rounded-full",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      data-portal="https://mzizi.dev/components/button"
      data-variant={variant ?? "default"}
      data-size={size ?? "default"}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
