"use client";

import { useEffect, useState } from "react";
import { LocationWeatherCard } from "@/components/weather/LocationWeatherCard";
import { displayNameFromSlug, isLocationSlug } from "@/lib/current-slug";
import {
  buildLocationList,
  cardAccessibleName,
  cardHref,
  localTimeLabel,
  summarizeCardWeather,
  type CardSummary,
  type CardWeatherInput,
  type LocationListEntry,
} from "@/lib/location-card";
import { LOCATIONS } from "@/lib/locations";
import { SearchIcon } from "@/lib/weather-icons";
import { MAX_SAVED_LOCATIONS, useAppStore } from "@/lib/store";

interface Props {
  /** `lastLocation` cookie read on the server, if it names a real location. */
  initialCurrentSlug: string | null;
}

interface PlaceRef {
  name: string;
  lat: number;
  lon: number;
  country: string | null;
}

interface CardState {
  status: "ready" | "error";
  place: PlaceRef | null;
  summary: CardSummary | null;
  /** Epoch ms when the weather was fetched; drives the local-time subtitle. */
  fetchedAt: number;
}

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
    {
      signal,
    },
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

/**
 * The Locations list: "My Location" first, then saved places, each a live
 * weather card. Everything per-place loads in parallel and degrades per card.
 */
export function LocationsClient({ initialCurrentSlug }: Props) {
  const selectedLocation = useAppStore((s) => s.selectedLocation);
  const savedLocations = useAppStore((s) => s.savedLocations);
  const homeLocation = useAppStore((s) => s.homeLocation);
  const setHomeLocation = useAppStore((s) => s.setHomeLocation);
  const removeLocation = useAppStore((s) => s.removeLocation);
  const openMyWeather = useAppStore((s) => s.openMyWeather);

  const currentSlug = isLocationSlug(selectedLocation)
    ? selectedLocation
    : initialCurrentSlug;
  const entries = buildLocationList(
    currentSlug,
    savedLocations,
    MAX_SAVED_LOCATIONS,
  );
  const entriesKey = entries.map((e) => e.slug).join("|");

  const [cards, setCards] = useState<Record<string, CardState>>({});

  useEffect(() => {
    const controller = new AbortController();
    const slugs = entriesKey ? entriesKey.split("|") : [];
    for (const slug of slugs) {
      void (async () => {
        try {
          const place = await resolvePlace(slug, controller.signal);
          if (!place) throw new Error("place not found");
          const weather = await fetchCardWeather(place, controller.signal);
          const summary = summarizeCardWeather(
            weather,
            place.lon,
            place.country,
          );
          if (controller.signal.aborted) return;
          setCards((prev) => ({
            ...prev,
            [slug]: {
              status: summary ? "ready" : "error",
              place,
              summary,
              fetchedAt: Date.now(),
            },
          }));
        } catch {
          if (controller.signal.aborted) return;
          setCards((prev) => ({
            ...prev,
            [slug]: {
              status: "error",
              place: prev[slug]?.place ?? null,
              summary: null,
              fetchedAt: Date.now(),
            },
          }));
        }
      })();
    }
    return () => controller.abort();
  }, [entriesKey]);

  return (
    <>
      <h1 className="font-display text-3xl font-bold text-text-primary sm:text-4xl">
        Weather
      </h1>

      <ul aria-label="Locations" className="mt-6 flex flex-col gap-4">
        {entries.map((entry) => (
          <li key={entry.slug}>
            <LocationCardRow
              entry={entry}
              state={cards[entry.slug]}
              isHome={homeLocation === entry.slug}
              isSaved={savedLocations.includes(entry.slug)}
              onSetHome={() =>
                setHomeLocation(homeLocation === entry.slug ? null : entry.slug)
              }
              onRemove={() => removeLocation(entry.slug)}
            />
          </li>
        ))}
      </ul>

      {savedLocations.length === 0 && (
        <p className="mt-6 text-center text-text-secondary">
          Search to add places
        </p>
      )}

      <div className="sticky bottom-[4.5rem] z-30 mt-8 sm:bottom-4">
        <button
          type="button"
          onClick={() => openMyWeather("location")}
          className="impala flex w-full justify-start bg-surface-card text-left text-base shadow-md"
        >
          <SearchIcon className="shrink-0" size={20} />
          <span>Search for a city or airport</span>
        </button>
      </div>
    </>
  );
}

interface RowProps {
  entry: LocationListEntry;
  state: CardState | undefined;
  isHome: boolean;
  isSaved: boolean;
  onSetHome: () => void;
  onRemove: () => void;
}

function LocationCardRow({
  entry,
  state,
  isHome,
  isSaved,
  onSetHome,
  onRemove,
}: RowProps) {
  const name = state?.place?.name ?? displayNameFromSlug(entry.slug);
  const summary = state?.summary ?? null;
  const status: "loading" | "ready" | "error" = !state
    ? "loading"
    : state.status;

  // The current place is labelled as such; other places show their local time
  // at the moment the weather was fetched.
  let subtitle = "My Location";
  if (!entry.isCurrent) {
    subtitle =
      state && summary
        ? localTimeLabel(state.fetchedAt, summary.utcOffsetSeconds)
        : "";
  }

  const menu = [
    {
      label: isHome ? "Remove Home" : "Set as Home",
      onSelect: onSetHome,
    },
    ...(isSaved
      ? [{ label: "Remove", onSelect: onRemove, tone: "danger" as const }]
      : []),
  ];

  return (
    <LocationWeatherCard
      href={cardHref(entry)}
      name={name}
      subtitle={subtitle}
      isHome={isHome}
      status={status}
      summary={summary}
      accessibleName={cardAccessibleName({
        name,
        summary,
        isCurrent: entry.isCurrent,
        isHome,
      })}
      menu={menu}
    />
  );
}
