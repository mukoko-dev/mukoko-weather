import { cn } from "@/lib/utils";
import type { attributionForLayer } from "@/lib/map-sources";

/**
 * A map's credits, rendered from `attributionForLayer()` in map-sources.ts so
 * every provider whose data is on screen is named and linked from the one
 * source of truth. Never hand-write a credit string. Shared by the full map
 * (MapDashboard) and the location page's static preview (MapPreview).
 *
 * Not for use inside another link: the credits are links themselves.
 */
export function MapCredits({
  credits,
  className,
}: {
  credits: ReturnType<typeof attributionForLayer>;
  className?: string;
}) {
  return (
    <p className={cn("mt-1 text-sm text-text-tertiary", className)}>
      <span className="sr-only">Map and data sources: </span>
      {credits.map((p, i) => (
        <span key={p.id}>
          {i > 0 && " · "}
          <a
            href={p.href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            {p.label}
          </a>
        </span>
      ))}
    </p>
  );
}
