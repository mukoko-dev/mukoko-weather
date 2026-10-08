import { cn } from "@/lib/utils";

/**
 * Aspect-matched placeholder for CommunityLane. Mirrors the section's
 * rhythm (heading, a pin row, an hour axis, two lanes, a legend) so the
 * page does not shift when the lane mounts.
 */
export function CommunityLaneSkeleton({ className }: { className?: string }) {
  return (
    <section
      role="status"
      aria-label="Loading"
      className={cn("baobab space-y-4", className)}
    >
      <div className="space-y-2">
        <div className="chameleon h-6 w-40" />
        <div className="chameleon h-4 w-64" />
      </div>
      <div className="chameleon h-12 w-full" />
      <div className="grid grid-cols-8 gap-2">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="chameleon h-4" />
        ))}
      </div>
      {Array.from({ length: 2 }, (_, i) => (
        <div key={i} className="space-y-2 border-l-4 border-surface-dim pl-3">
          <div className="chameleon h-5 w-48" />
          <div className="chameleon h-10 w-full" />
        </div>
      ))}
    </section>
  );
}
