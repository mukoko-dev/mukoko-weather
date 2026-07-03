"use client";

/**
 * ServiceWorkerUpdater — makes the Serwist PWA auto-update instead of serving
 * stale content until a hard refresh.
 *
 * Two problems this solves on Android (and desktop) PWAs:
 *   (a) When a new version deploys, the new service worker activates (skipWaiting)
 *       but the already-open page/PWA window doesn't reload — so the user keeps
 *       seeing the old shell.
 *   (b) An INSTALLED Android PWA doesn't re-check for a new SW when reopened, so
 *       users never even discover the new version.
 *
 * This component does NOT register the service worker — `@serwist/next` already
 * does that (register defaults to true). It only layers update-detection +
 * auto-reload on top:
 *   - On mount + whenever the document becomes visible again (visibilitychange)
 *     + on window focus, it calls registration.update() to force a fresh check
 *     of /sw.js. With skipWaiting the new SW activates immediately.
 *   - A one-time guarded `controllerchange` listener reloads the page exactly
 *     once when a NEW service worker takes control — but only on a genuine
 *     controller *swap*, never on the first controllerchange fired during the
 *     initial registration (when there was no prior controller at page load).
 *
 * Renders nothing. Fully defensive — no-ops when Service Workers are unsupported.
 */

import { useEffect } from "react";

// Module-level guard: survives re-mounts, ensures we only ever reload once even
// if multiple controllerchange events fire.
let reloaded = false;

export function ServiceWorkerUpdater() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }

    const sw = navigator.serviceWorker;

    // Snapshot whether a controller already existed at page load. If it was
    // null, the FIRST controllerchange is the initial registration taking
    // control (clientsClaim) — reloading then would be a spurious reload on
    // first visit. We only want to reload on a genuine controller *swap*.
    const hadControllerAtLoad = Boolean(sw.controller);

    const handleControllerChange = () => {
      if (reloaded) return;
      // Skip the very first controllerchange when there was no controller at
      // page load — that's the initial claim, not a version swap.
      if (!hadControllerAtLoad) return;
      reloaded = true;
      try {
        window.location.reload();
      } catch {
        // no-op — reload is best-effort
      }
    };

    // Ask the browser to re-check /sw.js for a newer worker. With skipWaiting
    // set in the SW, a newer worker activates → fires controllerchange → reload.
    const checkForUpdate = () => {
      try {
        sw.getRegistration()
          .then((registration) => registration?.update())
          .catch(() => {
            // no-op — update check is best-effort
          });
      } catch {
        // no-op — some browsers throw synchronously when unsupported
      }
    };

    // Only re-check when the tab actually becomes visible (reopening an
    // installed PWA fires this), not when it's being hidden.
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        checkForUpdate();
      }
    };

    try {
      sw.addEventListener("controllerchange", handleControllerChange);
      document.addEventListener("visibilitychange", handleVisibilityChange);
      window.addEventListener("focus", checkForUpdate);
      // Check once on mount so a page that was left open picks up a deploy.
      checkForUpdate();
    } catch {
      // no-op — wiring listeners should never break the app
    }

    return () => {
      try {
        sw.removeEventListener("controllerchange", handleControllerChange);
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        window.removeEventListener("focus", checkForUpdate);
      } catch {
        // no-op
      }
    };
  }, []);

  return null;
}
