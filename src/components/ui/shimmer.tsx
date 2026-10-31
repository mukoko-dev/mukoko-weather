import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A quiet placeholder bar for loading skeletons (the `.okapi` fauna class).
 *
 * It is tinted from the surrounding text colour, so it reads on the hero sky
 * plate and on a card in both themes, and a soft highlight slides across it.
 * The slide runs only under `prefers-reduced-motion: no-preference`; with
 * Reduce Motion it is a static block (no animation at all).
 *
 * Decorative: `aria-hidden`. A skeleton announces itself once through its own
 * status region, never block by block. Size it with width/height classes; put
 * it inside a text element carrying the real text classes and give it an
 * `em` height, and the line box keeps the real text's height.
 */
function Shimmer({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      data-slot="shimmer"
      className={cn("okapi", className)}
      {...props}
    />
  );
}

export { Shimmer };
