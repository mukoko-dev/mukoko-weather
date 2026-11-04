"use client";

import { useEffect, useState } from "react";
import {
  FLOATING_CARD_CLASS,
  FloatingStack,
} from "@/components/ui/floating-stack";
import { LocationSkeleton } from "@/components/weather/LocationSkeleton";
import { PlaceNotFound } from "@/components/weather/PlaceNotFound";
import { PlaceStage } from "@/components/weather/PlaceStage";
import { lookupPlace, type PlaceLookup } from "@/lib/place-resolve";

/**
 * A place page for a slug the server could not name without a lookup
 * (issue #452): not a shipped place and not a spot, so a community place, an
 * OSM reference or a name nobody holds. The server sent the shell and this;
 * the browser asks the Worker through the shared read.
 *
 * - found: the place stage takes over (stored copy, then the visitor's own
 *   forecast), exactly as for a place the server named;
 * - missing: the Worker answered that no such place exists: the not-found
 *   view, rendered here (the status was already sent, so it says `noindex`);
 * - unavailable: nothing answered. That says nothing about the place, so it is
 *   never shown as "not found": a calm notice over the skeleton, with "Try
 *   again" (and an automatic attempt when the browser comes back online).
 */
export function PlaceResolver({ slug }: { slug: string }) {
  const [attempt, setAttempt] = useState(0);
  const [lookup, setLookup] = useState<PlaceLookup | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void lookupPlace(slug, controller.signal, { force: attempt > 0 }).then(
      (result) => {
        if (!controller.signal.aborted) setLookup(result);
      },
    );
    return () => controller.abort();
  }, [slug, attempt]);

  const unavailable = lookup?.kind === "unavailable";
  useEffect(() => {
    if (!unavailable) return;
    const again = () => {
      setLookup(null);
      setAttempt((n) => n + 1);
    };
    window.addEventListener("online", again);
    return () => window.removeEventListener("online", again);
  }, [unavailable]);

  if (lookup?.kind === "found") {
    return <PlaceStage key={lookup.seed.location.slug} seed={lookup.seed} />;
  }
  if (lookup?.kind === "missing") return <PlaceNotFound />;

  return (
    <>
      {/* The page's heading, for crawlers and screen readers, until the
          place is known and the dashboard renders its own. */}
      <h1 className="sr-only">Weather forecast</h1>
      <LocationSkeleton />
      {unavailable && (
        <FloatingStack>
          <section
            role="alert"
            aria-label="Place could not be looked up"
            className={FLOATING_CARD_CLASS}
          >
            <div className="flex items-center gap-3">
              <p className="min-w-0 flex-1 text-sm text-text-primary">
                Couldn&apos;t look up this place right now.
              </p>
              <button
                type="button"
                className="kudu-sm shrink-0"
                onClick={() => {
                  setLookup(null);
                  setAttempt((n) => n + 1);
                }}
              >
                Try again
              </button>
            </div>
          </section>
        </FloatingStack>
      )}
    </>
  );
}
