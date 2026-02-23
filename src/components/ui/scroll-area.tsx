"use client"

import * as React from "react"
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"

import { cn } from "@/lib/utils"

function ScrollArea({
  className,
  children,
  fixRadixTableLayout = false,
  viewportRef,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  /** Fix Radix's internal display:table on the viewport wrapper div.
   *  Radix wraps children in a div with display:table which breaks flex/block
   *  layouts (e.g. the Shamwari chatbot message list). Set to true to override
   *  the wrapper to display:block. Only opt in where needed — other ScrollArea
   *  usages are unaffected.
   *  Tested with @radix-ui/react-scroll-area@1.4.3 — verify after upgrades.
   *  See: https://github.com/radix-ui/primitives/issues/926 */
  fixRadixTableLayout?: boolean;
  /** Ref forwarded to the Radix Viewport element — use this for scroll
   *  position tracking or programmatic scrolling instead of querying
   *  internal Radix attributes. */
  viewportRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport ref={viewportRef} className={cn("h-full w-full rounded-[inherit]", fixRadixTableLayout && "[&>div]:!block")}>
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-bar"
      orientation={orientation}
      className={cn(
        "flex touch-none select-none transition-colors",
        orientation === "vertical" &&
          "h-full w-2.5 border-l border-l-transparent p-px",
        orientation === "horizontal" &&
          "h-2.5 flex-col border-t border-t-transparent p-px",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-text-tertiary/30" />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
