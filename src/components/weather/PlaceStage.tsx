"use client";

import {
  Children,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import { FloatingStack } from "@/components/ui/floating-stack";
import { LocationSkeleton } from "@/components/weather/LocationSkeleton";
import { PlaceLoadNotice } from "@/components/weather/PlaceLoadNotice";
import { ChartErrorBoundary } from "@/components/weather/ChartErrorBoundary";
import type { AISummaryUser } from "@/components/weather/AISummary";
import { fetchHomeWeather } from "@/lib/home-weather";
import { workerData } from "@/lib/worker-data";
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
    // Through the shared Worker read (src/lib/worker-data.ts) via
    // fetchHomeWeather: one call per place, never a raw Worker call. The
    // shared request outlives a place the visitor left, so its answer is
    // there if they come back; the controller ignores it for the screen.
    fetchWeather: (lat, lon, _signal, options) => {
      if (options?.force) workerData.invalidate("weather", { lat, lon });
      return fetchHomeWeather(lat, lon);
    },
    resolve: (slug, signal) => resolvePlaceSeed(slug, signal),
    history: {
      path: () => window.location.pathname,
      push: (path) => window.history.pushState(null, "", path),
      replace: (path) => window.history.replaceState(null, "", path),
    },
    onShow({ seed, isHome, url }) {
      const slug = seed.location.slug;
      useAppStore.getState().setSelectedLocation(slug);
      try {
        document.title = placeDocumentTitle(seed.location.name);
      } catch {
        /* no document */
      }
      // The place the visitor is on is the one `/` should open on next time.
      // Written here, not only by the edge proxy: a stored page is served by
      // the service worker without reaching the proxy, and the proxy now
      // sets the cookie only when its value changes, so this also keeps its
      // 30 days fresh.
      if (!isHome) writeLastLocationCookie(slug);
      if (url === "none") return;
      // A switch the visitor made: start the new place at the top of the page.
      try {
        window.scrollTo({ top: 0, behavior: "auto" });
      } catch {
        /* no window */
      }
    },
  };
}

/** Paths the router was already asked to render once (never loops). */
const replaced = new Set<string>();

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
  const router = useRouter();

  useEffect(() => {
    // Fetch the dashboard's code now; it renders as soon as a view exists.
    void loadDashboard().catch(() => {});
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
      // A place URL this stage cannot show: let the router render it from the
      // server (a soft navigation, once per path), never a page reload.
      if (live && !handled && !replaced.has(pathname)) {
        replaced.add(pathname);
        router.replace(pathname);
      }
    });
    return () => {
      live = false;
    };
  }, [controller, pathname, router]);

  // The browser coming back online, or the page becoming visible again, is one
  // more attempt for a place whose forecast has not arrived (live-fetch.ts).
  useEffect(() => {
    const onOnline = () => controller.nudge("online");
    const onVisible = () => {
      if (document.visibilityState === "visible") controller.nudge("visible");
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [controller]);

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

  const notice = state.failed ? (
    <PlaceLoadNotice
      placeName={seed.location.name}
      showingSaved={!!view}
      busy={state.fetching}
      onRetry={retry}
    />
  ) : state.slow && !view ? (
    // The retries are still running and there is nothing stored to show: say
    // so, over the same skeleton, and offer the button now.
    <PlaceLoadNotice
      slow
      placeName={seed.location.name}
      showingSaved={false}
      busy={state.trying}
      onRetry={retry}
    />
  ) : null;
  const extras = Children.toArray(children);

  return (
    <>
      {view ? (
        <ChartErrorBoundary name="weather dashboard">
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
          />
        </ChartErrorBoundary>
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
      {/* Floating cards (the load notice, and the home page's location ask)
          share one column above the mobile nav, so two never overlap. */}
      {(notice || extras.length > 0) && (
        <FloatingStack>
          {notice}
          {extras}
        </FloatingStack>
      )}
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
