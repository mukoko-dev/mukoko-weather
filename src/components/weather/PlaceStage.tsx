"use client";

import {
  Children,
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
import { useAiUser } from "@/lib/use-ai-user";
import { fetchHomeWeather, fetchWorkerWeatherOnce } from "@/lib/home-weather";
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
import { recallHomeSnapshot } from "@/lib/home-snapshot";
import { useAppStore } from "@/lib/store";
import { readDeviceHints } from "@/lib/lazy-visibility";
import { useIdleOnce } from "@/lib/use-idle-once";
import { pagerSequence } from "@/lib/location-pager";
import {
  WARM_PAUSE_AFTER_FAILURE_MS,
  warmLimit,
  warmPass,
  warmTargets,
} from "@/lib/place-warm";

/** The longest to wait for an idle moment before warming the next places. */
const WARM_IDLE_TIMEOUT_MS = 1500;

/**
 * The dashboard is a separate chunk: the server HTML carries only the shell
 * and a skeleton, so the dashboard's code (charts, drag-and-drop, the sky)
 * is fetched after first paint, in parallel with the stored copy and the
 * visitor's own weather request, instead of in the first-load JavaScript.
 */
const loadDashboard = () =>
  import("@/app/[location]/WeatherDashboard").then((m) => m.WeatherDashboard);
// Asked for as soon as this module runs (the page's own code, before it
// hydrates) rather than from an effect after hydration: the stored place is
// ready the moment the page is, and what it waits for is this code. A page
// that never shows a place does not import this module.
if (typeof window !== "undefined") void loadDashboard().catch(() => {});
const WeatherDashboard = dynamic(loadDashboard, {
  ssr: false,
  // The stored copy is ready before the dashboard's code is: keep the skeleton
  // up for that moment rather than a blank page.
  loading: () => <LocationSkeleton />,
});

/**
 * Resolves once the tab is visible (at once when it already is), or when
 * `signal` aborts: background warming waits for the visitor instead of running
 * in a hidden tab, and carries on when they come back.
 */
function untilVisible(signal: AbortSignal): Promise<void> {
  if (document.visibilityState !== "hidden") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      document.removeEventListener("visibilitychange", onChange);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const onChange = () => {
      if (document.visibilityState !== "hidden") done();
    };
    document.addEventListener("visibilitychange", onChange);
    signal.addEventListener("abort", done);
  });
}

/** The browser's side of `PlaceDeps`. */
function browserDeps(): PlaceDeps {
  return {
    now: () => Date.now(),
    recall: (slug) => recallPlace(slug),
    // The last place `/` showed, read from localStorage in one step: it paints
    // before the database below has started (src/lib/home-snapshot.ts).
    recallQuick: (slug) => recallHomeSnapshot(slug, Date.now()),
    // Through the shared Worker read (src/lib/worker-data.ts) via
    // fetchHomeWeather: one call per place, never a raw Worker call. The
    // shared request outlives a place the visitor left, so its answer is
    // there if they come back; the controller ignores it for the screen.
    fetchWeather: (lat, lon, _signal, options) => {
      // A place nobody asked for yet (the next saved place, got ready in the
      // background): the Worker only, one attempt, never the provider direct.
      if (options?.background) return fetchWorkerWeatherOnce(lat, lon);
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
    // (Asked for once already when this module ran; this asks again if that
    // request failed, and costs nothing if it did not.)
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

  // Get the places a swipe can reach next ready while this one is read
  // (src/lib/place-warm.ts): the visitor's SAVED places only (never the
  // suggested ones they did not choose), once the place on screen has its own
  // forecast and the browser has had an idle moment, one request at a time. A
  // hidden tab waits for the visitor to come back; a pass that fails pauses
  // warming for a minute. The answer is held in memory, so the switch paints at
  // once instead of waiting.
  const savedLocations = useAppStore((s) => s.savedLocations);
  const warmSequence = useMemo(
    () => pagerSequence(savedLocations, []),
    [savedLocations],
  );
  const settled = !!state.view && !state.fetching && !state.failed;
  const idle = useIdleOnce(WARM_IDLE_TIMEOUT_MS, state.path);
  const pausedUntil = useRef(0);
  useEffect(() => {
    if (!settled || !idle || Date.now() < pausedUntil.current) return;
    const limit = warmLimit(readDeviceHints(), navigator.onLine !== false);
    const targets = warmTargets(warmSequence, state.path, limit);
    if (targets.length === 0) return;
    const stop = new AbortController();
    void warmPass(targets, (target) => controller.warm(target, stop.signal), {
      signal: stop.signal,
      untilVisible,
    }).then((end) => {
      if (end === "failed") {
        pausedUntil.current = Date.now() + WARM_PAUSE_AFTER_FAILURE_MS;
      }
    });
    return () => stop.abort();
  }, [controller, settled, idle, warmSequence, state.path]);

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
  isCurrentLocation = false,
  children,
}: {
  stage: PlaceStageApi;
  isCurrentLocation?: boolean;
  /** Extra UI that belongs to the page (the home page's location card). */
  children?: ReactNode;
}) {
  const { state, retry } = stage;
  // Read in the browser from AuthKit's provider, not handed down by a server
  // render that had to wait for the session (issue #452).
  const user = useAiUser();
  const { seed, view, device } = state;
  if (!seed) return null;

  // Distinct keys: the failed notice is an `alert` that must MOUNT as a new
  // element (a role changed on a reused node is not announced), not turn into
  // one when the retries run out.
  const notice = state.failed ? (
    <PlaceLoadNotice
      key="failed"
      placeName={seed.location.name}
      showingSaved={!!view}
      busy={state.fetching}
      onRetry={retry}
    />
  ) : state.slow && !view ? (
    // The retries are still running and there is nothing stored to show: say
    // so, over the same skeleton, and offer the button now.
    <PlaceLoadNotice
      key="slow"
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
          {extras}
          {notice}
        </FloatingStack>
      )}
    </>
  );
}

/** A place page (`/[location]`): the stage with nothing around it. */
export function PlaceStage({ seed }: { seed: PlaceSeed }) {
  const stage = usePlaceStage(seed, false);
  return <PlaceView stage={stage} />;
}
