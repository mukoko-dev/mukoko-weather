"use client";

import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/lib/store";
import { SafeMarkdown } from "@/components/ui/safe-markdown";
import { SkeletonLines } from "@/components/ui/skeleton";

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
  /** Farm data is ready: no model call while it is unavailable. */
  enabled: boolean;
}

type Result =
  { key: string; ok: true; text: string } | { key: string; ok: false };

export function AgricultureBriefing({ location, crops, user, enabled }: Props) {
  const openMyWeather = useAppStore((s) => s.openMyWeather);
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
  // No crops picked: no model call (same rule as the snapshot card).
  const wantsAI = signedIn && enabled && crops.length > 0;

  useEffect(() => {
    if (!wantsAI || peekAgriAI(body) !== undefined) return;
    let live = true;
    fetchAgriAI(body)
      .then((text) => live && setResult({ key: body, ok: true, text }))
      .catch(() => live && setResult({ key: body, ok: false }));
    return () => {
      live = false;
    };
  }, [wantsAI, body]);

  if (!signedIn) {
    return (
      <ShamwariSignInCTA
        title="Shamwari agronomy briefing"
        body={`Sign in for Shamwari's farm briefing for ${name}, written for your crops.`}
        accent="malachite"
      />
    );
  }

  if (crops.length === 0) {
    return (
      <section
        aria-labelledby="agri-briefing"
        className="baobab border-mineral-malachite/40"
      >
        <h2 id="agri-briefing" className="giraffe">
          Shamwari agronomy briefing
        </h2>
        <p className="gazelle mt-3">
          Tell us what you farm and Shamwari will write a briefing for {name}.{" "}
          <button
            type="button"
            onClick={() => openMyWeather("activities")}
            className="sunbird dik-dik"
          >
            Pick your crops
          </button>
        </p>
      </section>
    );
  }

  if (!enabled) return null;

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
      className="baobab border-mineral-malachite/40"
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
          <SkeletonLines
            widths={["w-3/4", "w-full", "w-2/3"]}
            label="Loading the agronomy briefing"
          />
        )}
      </div>
    </section>
  );
}
