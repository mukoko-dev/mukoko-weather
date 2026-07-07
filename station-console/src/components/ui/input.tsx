import * as React from "react";

import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   INPUT — Layer 2 Primitive
   
   Nyuchi Frontend Architecture: Layer 2 (Primitives)
   
   Token compliance:
   ✅ Radius: rounded-full (9999px) — inputs use pill radius per brand
   ✅ Touch target: h-12 (48px) — meets minimum touch target
   ✅ Focus ring: uses --ring token from semantic layer
   ✅ Colors: uses semantic tokens (input, foreground, muted-foreground)
   ✅ data-slot: present for CSS targeting
   
   Height was 36px (h-9) — VIOLATION of 48px minimum.
   Now 48px (h-12) as the base, with touch-safe proportions.
   ═══════════════════════════════════════════════════════════════ */

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      data-portal="https://mzizi.dev/components/input"
      className={cn(
        "h-12 w-full min-w-0 rounded-full border border-input bg-input/30 px-4 py-1 text-base transition-colors outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20 md:text-sm dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
