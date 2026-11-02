"use client";

import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { LocationSkeleton } from "@/components/weather/LocationSkeleton";
import { PlaceLoadNotice } from "@/components/weather/PlaceLoadNotice";
import type { AISummaryUser } from "@/components/weather/AISummary";
import { fetchHomeWeather } from "@/lib/home-weather";
import {
  createPlaceController,
  type PlaceController,
  type PlaceDeps,
  type PlaceSeed,
  type PlaceState,
} from "@/lib/place-controller";
import { registerPlaceStage } from "@/lib/place-bus";
import { resolvePlaceSeed } from "@/lib/place-resolve";
import { placeDocumentTitle } from "@/lib/place-target";
import { writeLastLocationCookie } from "@/lib/current-slug";
import { recallPlace } from "@/lib/rxdb/weather-places";
import { useAppStore } from "@/lib/store";

/**
 * The dashboard is a separate chunk: the server HTML carries only the shell
 * and a skeleton, so the dashboard's code (charts, drag-and-drop, the sky)
 * is fetched after first paint, in parallel with the stored copy and the
 * visitor's own weather request, instead of in the first-load JavaScript.
 */
const loadDashboard = () =>
  import("@/app/[location]/WeatherDashboard").then((m) => m.WeatherDashboard);
const WeatherDashboard = dynamic(loadDashboard, {
  ssr: false,
  // The stored copy is ready before the dashboard's code is: keep the skeleton
  // up for that moment rather than a blank page.
  loading: () => <LocationSkeleton />,
});

/** The browser's side of `PlaceDeps`. */
function browserDeps(): PlaceDeps {
  return {
    now: () => Date.now(),
    recall: (slug) => recallPlace(slug),
    fetchWeather: (lat, lon) => fetchHomeWeather(lat, lon),
    resolve: (slug, signal) => resolvePlaceSeed(slug, signal),
    history: {
      path: () => window.location.pathname,
      push: (path) => window.history.pushState(null, "", path),
      replace: (path) => window.history.replaceState(null, "", path),
    },
    onShow({ seed, url }) {
      const slug = seed.location.slug;
      useAppStore.getState().setSelectedLocation(slug);
      try {
        document.title = placeDocumentTitle(seed.location.name);
      } catch {
        /* no document */
      }
      if (url === "none") return;
      // A switch the visitor made: remember it for the next visit and start
      // the new place at the top of the page.
      writeLastLocationCookie(slug);
      try {
        window.scrollTo({ top: 0, behavior: "auto" });
      } catch {
        /* no window */
      }
    },
  };
}

/** Paths a hard reload was already tried for (never loops). */
const reloaded = new Set<string>();

export interface PlaceStageApi {
  state: PlaceState;
  controller: PlaceController;
  retry(): void;
}

/**
 * Own the place on screen for a page: the server's seed (a place, no weather),
 * then the stored copy, then the visitor's own weather request. Registers with
 * the switch bus, and follows the pathname so back/forward and router
 * navigations to a place URL show that place without remounting the page.
 */
export function usePlaceStage(
  seed: PlaceSeed | null,
  isHome: boolean,
): PlaceStageApi {
  const [controller] = useState(() =>
    createPlaceController(browserDeps(), {
      seed,
      isHome,
      path: isHome || !seed ? "/" : `/${seed.location.slug}`,
    }),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  const pathname = usePathname();

  useEffect(() => {
    // Fetch the dashboard's code now; it renders as soon as a view exists.
    void loadDashboard();
    const unregister = registerPlaceStage({
      canShow: (target) => target.kind === "slug" || !!controller.homeSeed(),
      show: (target) => controller.showTarget(target, "push"),
    });
    void controller.start();
    return () => {
      unregister();
      controller.dispose();
    };
  }, [controller]);

  useEffect(() => {
    let live = true;
    void controller.reconcile(pathname).then((handled) => {
      // A place URL this stage cannot show (and no router will): load it
      // from the server, once.
      if (live && !handled && !reloaded.has(pathname)) {
        reloaded.add(pathname);
        window.location.reload();
      }
    });
    return () => {
      live = false;
    };
  }, [controller, pathname]);

  const retry = useCallback(() => void controller.retry(), [controller]);
  return { state, controller, retry };
}

/**
 * What a place stage shows: the dashboard once a view exists, else the
 * structural skeleton (server-rendered, so the first byte is the shell), plus
 * the retry notice when the visitor's own request failed.
 */
export function PlaceView({
  stage,
  user,
  isCurrentLocation = false,
  children,
}: {
  stage: PlaceStageApi;
  user: AISummaryUser | null;
  isCurrentLocation?: boolean;
  /** Extra UI that belongs to the page (the home page's location card). */
  children?: ReactNode;
}) {
  const { state, retry } = stage;
  const { seed, view, device } = state;
  if (!seed) return null;

  return (
    <>
      {view ? (
        <WeatherDashboard
          weather={view.weather}
          location={view.location}
          usingFallback={view.usingFallback}
          frostAlert={view.frostAlert}
          season={view.season}
          countryName={view.countryName}
          user={user}
          isCurrentLocation={isCurrentLocation && state.isHome}
          device={device}
          onRetry={retry}
        />
      ) : (
        <>
          {/* The page's heading is server-rendered for crawlers and screen
              readers; the dashboard renders its own once it mounts. */}
          <h1 className="sr-only">
            {seed.location.name} Weather Forecast — Current Conditions and 7-Day
            Outlook
          </h1>
          <LocationSkeleton slug={seed.location.slug} />
        </>
      )}
      {state.failed && (
        <PlaceLoadNotice
          placeName={seed.location.name}
          showingSaved={!!view}
          busy={state.fetching}
          onRetry={retry}
        />
      )}
      {children}
    </>
  );
}

/** A place page (`/[location]`): the stage with nothing around it. */
export function PlaceStage({
  seed,
  user,
}: {
  seed: PlaceSeed;
  user: AISummaryUser | null;
}) {
  const stage = usePlaceStage(seed, false);
  return <PlaceView stage={stage} user={user} />;
}
