"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useHydrated } from "./use-hydrated";
import { getFeatureFlag } from "./feature-flags";
import {
  pushRow,
  permissionToRecord,
  type PushRow,
  type PushRowInput,
} from "./notification-delivery";
import { recordPermission } from "./device-state";
import {
  detectEnv,
  disablePush,
  enablePush,
  pushApi,
  type PushEnv,
  type RegistrationLike,
} from "./push/client";

type LastResult = PushRowInput["lastResult"];

function registration(): Promise<RegistrationLike> {
  return navigator.serviceWorker.ready as unknown as Promise<RegistrationLike>;
}

/**
 * The "Push on this device" row of the notification settings, wired to
 * `push/client.ts` (#289). The row's state is `pushRow()` (pure); this hook
 * only reads the browser, runs the one action the row offers, and remembers the
 * permission outcome in the device state.
 *
 * `serverReady` is `FLAGS.web_push`: while the alert service is not live the
 * row says so and `onAction` does nothing. The permission prompt is raised
 * only from `onAction`, which the caller wires to a tap.
 */
export function useDevicePush(): {
  row: PushRow;
  busy: boolean;
  onAction: () => void;
} {
  // The browser's facts, read once the page has hydrated (the server render
  // and the first client render are "checking") and again after an attempt
  // may have changed the permission (`recheck`).
  const hydrated = useHydrated();
  const [recheck, setRecheck] = useState(0);
  const env: PushEnv | null = useMemo(
    () => (hydrated ? detectEnv() : null),
    // `recheck` makes the memo read the browser again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hydrated, recheck],
  );
  const serverReady = hydrated && getFeatureFlag("web_push");
  const [subscribed, setSubscribed] = useState(false);
  const [lastResult, setLastResult] = useState<LastResult>(null);
  const [busy, setBusy] = useState(false);

  // Ask whether this browser already holds a subscription (only when push is
  // switched on at all). The answer arrives in a callback.
  const canAsk = Boolean(
    env && serverReady && env.hasServiceWorker && env.hasPushManager,
  );
  useEffect(() => {
    if (!canAsk) return;
    let alive = true;
    void registration()
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => {
        if (alive) setSubscribed(sub !== null);
      })
      .catch(() => {
        // Unknown means not subscribed: the row then offers to switch on.
      });
    return () => {
      alive = false;
    };
  }, [canAsk]);

  const row = pushRow({ env, serverReady, subscribed, lastResult });

  const onAction = useCallback(() => {
    if (busy || !env || !row.action) return;
    setBusy(true);
    const api = pushApi();
    const finish = (next: LastResult) => {
      setLastResult(next);
      setBusy(false);
    };
    if (row.action === "disable") {
      void disablePush({ registration, api }).then((result) => {
        if (result === "disabled" || result === "not-subscribed") {
          setSubscribed(false);
        }
        finish(result === "error" ? "error" : result);
      });
      return;
    }
    void enablePush({
      env,
      requestPermission: () => Notification.requestPermission(),
      registration,
      api,
    }).then((result) => {
      const outcome = permissionToRecord(result);
      if (outcome) recordPermission("notifications", outcome);
      if (result === "enabled") setSubscribed(true);
      // The permission may have changed: read the browser again.
      setRecheck((n) => n + 1);
      finish(result);
    });
  }, [busy, env, row.action]);

  return { row, busy, onAction };
}
