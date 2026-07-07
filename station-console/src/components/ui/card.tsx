import * as React from "react";

import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════
   CARD — Layer 2 Primitive
   
   Nyuchi Frontend Architecture: Layer 2 (Primitives)
   
   Token compliance:
   ✅ Radius: rounded-[var(--radius-lg,14px)] — THE Nyuchi card radius
   ✅ Inner radius: rounded-[var(--radius-md,12px)] for header/footer corners
   ✅ Colors: uses semantic tokens (card, card-foreground, foreground)
   ✅ Border: ring-1 ring-foreground/10 — consistent across themes
   ✅ data-slot: present on all sub-components
   
   The card is the most composed primitive in the system.
   Every brand component that shows content in a container
   ultimately renders a card.
   ═══════════════════════════════════════════════════════════════ */

function Card({
  className,
  size = "default",
  loading = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  size?: "default" | "sm";
  loading?: boolean;
}) {
  // Built-in loading state — every component from L2 up renders its own skeleton
  if (loading) {
    return (
      <div
        data-slot="card"
        data-portal="https://mzizi.dev/components/card"
        data-loading
        className={cn(
          "group/card flex flex-col gap-4 overflow-hidden rounded-[var(--radius-lg,14px)] bg-card p-6 text-sm ring-1 ring-foreground/10 animate-pulse",
          size === "sm" && "gap-3 p-4",
          className,
        )}
      >
        <div className="h-4 w-2/3 rounded bg-muted" />
        <div className="h-3 w-full rounded bg-muted" />
        <div className="h-3 w-4/5 rounded bg-muted" />
      </div>
    );
  }

  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        "group/card flex flex-col gap-6 overflow-hidden rounded-[var(--radius-lg,14px)] bg-card py-6 text-sm text-card-foreground ring-1 ring-foreground/10 has-[>img:first-child]:pt-0 data-[size=sm]:gap-4 data-[size=sm]:py-4 *:[img:first-child]:rounded-t-[var(--radius-md,12px)] *:[img:last-child]:rounded-b-[var(--radius-md,12px)]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-2 rounded-t-[var(--radius-md,12px)] px-6 group-data-[size=sm]/card:px-4 has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-6 group-data-[size=sm]/card:[.border-b]:pb-4",
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("text-base font-medium", className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className,
      )}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-6 group-data-[size=sm]/card:px-4", className)}
      {...props}
    />
  );
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-[var(--radius-md,12px)] px-6 group-data-[size=sm]/card:px-4 [.border-t]:pt-6 group-data-[size=sm]/card:[.border-t]:pt-4",
        className,
      )}
      {...props}
    />
  );
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
};
