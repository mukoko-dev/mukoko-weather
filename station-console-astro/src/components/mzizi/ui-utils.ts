import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Tailwind-merge configured for the Nyuchi Design System's custom type
 * scale. Without this, merge treats the named font sizes (`text-body`,
 * `text-h2`, …) as *colours* and drops a legitimately co-existing
 * `text-primary-foreground`. Declaring them in the `font-size` group
 * keeps colour + size independent, the way raw Tailwind generates them.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "display",
            "display-sm",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "body-lg",
            "body",
            "body-sm",
            "caption",
          ],
        },
      ],
    },
  },
});

/**
 * `cn` — the shadcn class-merge helper the Nyuchi Design System is built
 * on. Merges conditional class lists (clsx) and resolves Tailwind
 * conflicts last-wins (tailwind-merge). Every UI component composes its
 * variant classes through this.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
