import { cn } from "@/lib/utils";

/**
 * Shared loading spinner — the single source for the spinning-ring loading
 * indicator previously hand-rolled in six components. Size and ring colors
 * compose via className (tailwind-merge resolves the conflicts):
 *
 *   <Spinner />                                          // 16px, primary ring
 *   <Spinner className="h-8 w-8" />                      // larger
 *   <Spinner className="border-primary-foreground" />    // on a filled button
 *
 * Decorative by default (aria-hidden) — pair it with visible text or wrap it
 * in a role="status" container for screen readers.
 */
export function Spinner({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent",
        className,
      )}
      aria-hidden="true"
    />
  );
}
