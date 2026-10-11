"use client";

import { useEffect, useMemo, useState } from "react";
import { SafeMarkdown } from "@/components/ui/safe-markdown";
import { SparklesIcon } from "@/lib/weather-icons";
import { agriAIBody, fetchAgriAI, peekAgriAI } from "@/lib/agriculture-client";
import type { WeatherLocation } from "@/lib/locations";
import type { AISummaryUser } from "./AISummary";
import { ShamwariSignInCTA } from "./ShamwariSignInCTA";

/**
 * Shamwari's agronomy briefing for the agriculture page — the model explains
 * the deterministic farm data (`/api/ai/agriculture`, mode "briefing").
 * Signed-in only; anonymous visitors see the sign-in CTA.
 */

interface Props {
  location: Pick<
    WeatherLocation,
    "slug" | "name" | "lat" | "lon" | "country" | "elevation"
  >;
  crops: readonly string[];
  user: AISummaryUser | null;
}

type Result =
  | { key: string; ok: true; text: string }
  | { key: string; ok: false };

export function AgricultureBriefing({ location, crops, user }: Props) {
  const { slug, name, country, elevation, lat, lon } = location;
  const body = useMemo(
    () =>
      agriAIBody(
        { slug, name, country, elevation, lat, lon },
        crops,
        "briefing",
      ),
    [slug, name, country, elevation, lat, lon, crops],
  );
  const [result, setResult] = useState<Result | null>(null);
  const signedIn = user !== null;

  useEffect(() => {
    if (!signedIn || peekAgriAI(body) !== undefined) return;
    let live = true;
    fetchAgriAI(body)
      .then((text) => live && setResult({ key: body, ok: true, text }))
      .catch(() => live && setResult({ key: body, ok: false }));
    return () => {
      live = false;
    };
  }, [signedIn, body]);

  if (!signedIn) {
    return (
      <ShamwariSignInCTA
        title="Shamwari agronomy briefing"
        body={`Sign in for Shamwari's farm briefing for ${name}, written for your crops.`}
        accent="malachite"
      />
    );
  }

  const cached = peekAgriAI(body);
  const now: Result | null =
    cached !== undefined
      ? { key: body, ok: true, text: cached }
      : result?.key === body
        ? result
        : null;

  return (
    <section
      aria-labelledby="agri-briefing"
      className="baobab border-l-[6px] border-l-mineral-malachite"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="text-mineral-malachite">
          <SparklesIcon size={16} />
        </span>
        <h2 id="agri-briefing" className="giraffe">
          Shamwari agronomy briefing
        </h2>
      </div>
      <div className="mt-3" role="status" aria-live="polite">
        {now?.ok ? (
          <SafeMarkdown content={now.text} className="animate-fade-in" />
        ) : now ? (
          <p className="gazelle">
            The briefing is unavailable right now. The windows and charts on
            this page are still current.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="h-4 w-3/4 animate-pulse rounded-full bg-text-tertiary/20" />
            <div className="h-4 w-full animate-pulse rounded-full bg-text-tertiary/20" />
            <div className="h-4 w-2/3 animate-pulse rounded-full bg-text-tertiary/20" />
            <span className="sr-only">Loading the agronomy briefing</span>
          </div>
        )}
      </div>
    </section>
  );
}
