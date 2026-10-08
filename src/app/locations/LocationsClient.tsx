"use client";

import { useEffect, useState } from "react";
import { LocationWeatherCard } from "@/components/weather/LocationWeatherCard";
import { displayNameFromSlug, isLocationSlug } from "@/lib/current-slug";
import {
  CARD_FETCH_CONCURRENCY,
  CARD_WEATHER_TTL_MS,
  TtlCache,
  buildLocationList,
  cardAccessibleName,
  cardHref,
  localTimeLabel,
  mapWithConcurrency,
  summarizeCardWeather,
  type CardSummary,
  type CardWeatherInput,
  type LocationListEntry,
} from "@/lib/location-card";
import { LOCATIONS } from "@/lib/locations";
import {
  hiddenSuggestedSlugs,
  visiblePresetSlugs,
  type PresetAnchor,
} from "@/lib/location-presets";
import { MAX_SAVED_LOCATIONS, useAppStore } from "@/lib/store";
import { useStoreHydrated } from "@/lib/use-hydrated";
import { LocationsMenu } from "./LocationsMenu";
import { LocationsSearch } from "./LocationsSearch";

interface Props {
  /** `lastLocation` cookie read on the server, if it names a real location. */
  initialCurrentSlug: string | null;
  /** Rough position from the edge's IP geo headers, when present. */
  ipAnchor: PresetAnchor | null;
}

interface PlaceRef {
  name: string;
  lat: number;
  lon: number;
  country: string | null;
}

interface LoadedCard {
  place: PlaceRef;
  summary: CardSummary;
}

interface CardState {
  status: "ready" | "error";
  place: PlaceRef | null;
  summary: CardSummary | null;
}

/**
 * Weather per slug, kept in memory for 10 minutes. Revisiting the list, or a
 * saved place that is already shown, does not refetch inside that window.
 */
const cardCache = new TtlCache<LoadedCard>(CARD_WEATHER_TTL_MS);

/** Seed catalogue first (no request), then the lookup API for community places. */
async function resolvePlace(
  slug: string,
  signal: AbortSignal,
): Promise<PlaceRef | null> {
  const seed = LOCATIONS.find((loc) => loc.slug === slug);
  if (seed) {
    return {
      name: seed.name,
      lat: seed.lat,
      lon: seed.lon,
      country: seed.country ?? null,
    };
  }
  const res = await fetch(
    `/api/py/locations?slug=${encodeURIComponent(slug)}`,
    { signal },
  );
  if (!res.ok) return null;
  const body = (await res.json()) as {
    location?: { name?: string; lat?: number; lon?: number; country?: string };
  };
  const loc = body.location;
  if (!loc || typeof loc.lat !== "number" || typeof loc.lon !== "number") {
    return null;
  }
  return {
    name: loc.name || displayNameFromSlug(slug),
    lat: loc.lat,
    lon: loc.lon,
    country: loc.country ?? null,
  };
}

async function fetchCardWeather(
  place: PlaceRef,
  signal: AbortSignal,
): Promise<CardWeatherInput | null> {
  const res = await fetch(`/api/py/weather?lat=${place.lat}&lon=${place.lon}`, {
    signal,
  });
  if (!res.ok) return null;
  return (await res.json()) as CardWeatherInput;
}

async function loadCard(
  slug: string,
  signal: AbortSignal,
): Promise<LoadedCard | null> {
  const hit = cardCache.get(slug);
  if (hit) return hit;
  const place = await resolvePlace(slug, signal);
  if (!place) return null;
  const weather = await fetchCardWeather(place, signal);
  const summary = summarizeCardWeather(weather, place.lon, place.country);
  if (!summary) return null;
  const loaded = { place, summary };
  cardCache.set(slug, loaded);
  return loaded;
}

/** Re-render once a minute so the local-time labels keep moving. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/**
 * The Locations list, as weather cards. Order: My Location, then saved places,
 * then suggested places ("Your places"). Weather loads with a small concurrency
 * limit, one skeleton per card, and is cached per slug for 10 minutes.
 */
export function LocationsClient({ initialCurrentSlug, ipAnchor }: Props) {
  const selectedLocation = useAppStore((s) => s.selectedLocation);
  const savedLocations = useAppStore((s) => s.savedLocations);
  const homeLocation = useAppStore((s) => s.homeLocation);
  const setHomeLocation = useAppStore((s) => s.setHomeLocation);
  const removeLocation = useAppStore((s) => s.removeLocation);
  const hiddenPresetSlugs = useAppStore((s) => s.hiddenPresetSlugs);
  const hidePresetLocation = useAppStore((s) => s.hidePresetLocation);
  const restorePresetLocations = useAppStore((s) => s.restorePresetLocations);
  const presetAnchor = useAppStore((s) => s.presetAnchor);
  const setPresetAnchor = useAppStore((s) => s.setPresetAnchor);
  const locationNames = useAppStore((s) => s.locationNames);
  const hydrated = useStoreHydrated();
  const now = useMinuteClock();
  const [editing, setEditing] = useState(false);
  const [cards, setCards] = useState<Record<string, CardState>>({});

  const currentSlug = isLocationSlug(selectedLocation)
    ? selectedLocation
    : initialCurrentSlug;
  const entries = buildLocationList(
    currentSlug,
    savedLocations,
    MAX_SAVED_LOCATIONS,
  );
  const presets = visiblePresetSlugs({
    anchor: presetAnchor,
    hidden: hiddenPresetSlugs,
    saved: savedLocations,
    current: currentSlug,
  });
  const restorable = hiddenSuggestedSlugs(presetAnchor, hiddenPresetSlugs);
  const listed = [...entries.map((e) => e.slug), ...presets];
  const loadKey = listed.join("|");

  // Anchor the suggestions on first visit, once the stored value has loaded
  // (so a saved anchor is never overwritten by the IP guess).
  useEffect(() => {
    if (hydrated && !presetAnchor && ipAnchor) setPresetAnchor(ipAnchor);
  }, [hydrated, presetAnchor, ipAnchor, setPresetAnchor]);

  useEffect(() => {
    const controller = new AbortController();
    const slugs = loadKey ? loadKey.split("|") : [];
    void mapWithConcurrency(slugs, CARD_FETCH_CONCURRENCY, async (slug) => {
      let loaded: LoadedCard | null = null;
      try {
        loaded = await loadCard(slug, controller.signal);
      } catch {
        loaded = null;
      }
      if (controller.signal.aborted) return;
      setCards((prev) => ({
        ...prev,
        [slug]: loaded
          ? { status: "ready", place: loaded.place, summary: loaded.summary }
          : {
              status: "error",
              place: prev[slug]?.place ?? null,
              summary: null,
            },
      }));
    });
    return () => controller.abort();
  }, [loadKey]);

  const renderCard = (
    slug: string,
    kind: "current" | "saved" | "suggested",
  ) => {
    const state = cards[slug];
    const place = state?.place ?? null;
    const summary = state?.summary ?? null;
    const name =
      place?.name ?? locationNames[slug] ?? displayNameFromSlug(slug);
    const isHome = homeLocation === slug;
    const kindLabel =
      kind === "current"
        ? "My location"
        : kind === "saved"
          ? "Saved"
          : "Suggested";
    const timeLabel = summary
      ? localTimeLabel(now, summary.utcOffsetSeconds)
      : "";
    const label = [kindLabel, timeLabel].filter(Boolean).join(" · ");
    const isCurrent = kind === "current";
    const status: "loading" | "ready" | "error" = !state
      ? "loading"
      : state.status;

    const menu = [
      {
        label: isHome ? "Remove Home" : "Set as Home",
        onSelect: () => setHomeLocation(isHome ? null : slug),
      },
    ];

    const onRemove =
      kind === "saved"
        ? () => removeLocation(slug)
        : kind === "suggested"
          ? () => hidePresetLocation(slug)
          : undefined;

    return (
      <LocationWeatherCard
        href={cardHref({ slug, isCurrent })}
        name={name}
        label={label}
        isHome={isHome}
        status={status}
        summary={summary}
        accessibleName={cardAccessibleName({
          name,
          summary,
          isCurrent,
          isHome,
        })}
        menu={editing ? undefined : menu}
        editing={editing}
        removeLabel={
          kind === "suggested"
            ? `Hide ${name} from suggested places`
            : `Remove ${name} from your places`
        }
        onRemove={onRemove}
      />
    );
  };

  const currentEntry: LocationListEntry | undefined = entries.find(
    (e) => e.isCurrent,
  );
  const savedEntries = entries.filter((e) => !e.isCurrent);
  const hasPlaces = savedEntries.length > 0 || presets.length > 0;

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-display text-4xl font-semibold text-text-primary sm:text-5xl">
          Weather
        </h1>
        <LocationsMenu
          editing={editing}
          onToggleEditing={() => setEditing((v) => !v)}
        />
      </div>

      {currentEntry && (
        <section aria-label="My location" className="mt-6">
          <ul>
            <li>{renderCard(currentEntry.slug, "current")}</li>
          </ul>
        </section>
      )}

      <section aria-labelledby="your-places-heading" className="mt-8">
        <div className="flex items-center justify-between gap-3">
          <h2
            id="your-places-heading"
            className="font-heading text-lg font-semibold text-text-primary"
          >
            Your places
          </h2>
          {editing && (
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="impala-sm"
            >
              Done
            </button>
          )}
        </div>

        {savedEntries.length > 0 && (
          <ul aria-label="Saved places" className="mt-3 flex flex-col gap-4">
            {savedEntries.map((entry) => (
              <li key={entry.slug}>{renderCard(entry.slug, "saved")}</li>
            ))}
          </ul>
        )}

        {presets.length > 0 && (
          <ul
            aria-label="Suggested places"
            className="mt-3 flex flex-col gap-4"
          >
            {presets.map((slug) => (
              <li key={slug}>{renderCard(slug, "suggested")}</li>
            ))}
          </ul>
        )}

        {!hasPlaces && (
          <p className="mt-4 text-center text-text-secondary">
            Search to add places
          </p>
        )}

        {restorable.length > 0 && (
          <button
            type="button"
            onClick={restorePresetLocations}
            className="impala mt-4 w-full"
          >
            Restore suggested places
          </button>
        )}
      </section>

      <div className="sticky bottom-[4.5rem] z-30 mt-8 sm:bottom-4">
        <LocationsSearch listed={listed} />
      </div>
    </>
  );
}
