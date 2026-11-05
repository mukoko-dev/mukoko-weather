"use client";

/**
 * Where the person is signed in (mukoko-dev/mukoko-weather#320).
 *
 * Lists the person's own signed-in devices from `GET /api/devices`, marks
 * "This device", and signs another one out. For this device it also shows
 * what the browser has been allowed (location, notifications) and a one-line
 * summary of its preferences, from the local mirror. Other devices show their
 * permissions and preferences once the platform device record carries them
 * (ask 3 of #320); until then they honestly show only what is known.
 *
 * Never shows an IP address. The current device signs out through
 * `/auth/signout`, below, not from here.
 */

import { useCallback, useEffect, useState } from "react";
import { Laptop, Smartphone, Tablet } from "lucide-react";
import { useAppStore } from "@/lib/store";
import { readDeviceState, type DeviceState } from "@/lib/device-state";
import { isStandalone, type DeviceFormFactor } from "@/lib/device-info";
import {
  blockedHint,
  lastActiveLabel,
  permissionChip,
  preferencesSummary,
} from "@/lib/device-display";
import type { SignedInDevice } from "@/lib/device-sessions";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { fetchJsonOrThrow } from "@/lib/fetch-json";
import { ProfileGroup } from "@/components/profile/ProfileGroup";

type Load =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; devices: SignedInDevice[] };

const ICONS: Record<DeviceFormFactor, typeof Laptop> = {
  phone: Smartphone,
  tablet: Tablet,
  desktop: Laptop,
};

/** The caller's signed-in devices; throws on any failure. Sets no state. */
async function readDevices(): Promise<SignedInDevice[]> {
  const body = await fetchJsonOrThrow<{ devices?: SignedInDevice[] }>(
    "/api/devices",
    { init: { credentials: "same-origin" } },
  );
  return body.devices ?? [];
}

export function ProfileDevices() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [local, setLocal] = useState<DeviceState | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const theme = useAppStore((s) => s.theme);
  const savedLocations = useAppStore((s) => s.savedLocations);
  const selectedActivities = useAppStore((s) => s.selectedActivities);

  const refresh = useCallback(async () => {
    try {
      setLoad({ status: "ready", devices: await readDevices() });
    } catch {
      setLoad({ status: "error" });
    }
  }, []);

  useEffect(() => {
    // Browser-only facts (the stored permission state, the display mode, the
    // clock) are not in the server HTML, so they are read after mount and
    // applied from a frame callback, as `useStableNow` does: the first paint
    // matches the server and the commit is not asked to render twice at once.
    const frame = requestAnimationFrame(() => {
      setLocal(readDeviceState());
      setStandalone(isStandalone());
      setNow(Date.now());
    });
    // The first load. State is set from the promise callbacks, and only while
    // this effect is still current (`refresh`, above, serves the sign-out).
    let current = true;
    readDevices().then(
      (devices) => {
        if (current) setLoad({ status: "ready", devices });
      },
      () => {
        if (current) setLoad({ status: "error" });
      },
    );
    return () => {
      current = false;
      cancelAnimationFrame(frame);
    };
  }, []);

  async function signOut(id: string) {
    setBusyId(id);
    setProblem(null);
    try {
      const res = await fetch(`/api/devices/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
      });
      if (!res.ok && res.status !== 404) throw new Error("bad status");
      await refresh();
    } catch {
      setProblem("Could not sign that device out. Try again.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <ProfileGroup id="profile-devices" title="Devices">
      {load.status === "loading" && (
        <div
          role="status"
          aria-label="Loading"
          className="flex items-center gap-3 px-4 py-4 text-sm text-text-secondary"
        >
          <Spinner className="h-4 w-4" />
          Loading your devices
        </div>
      )}

      {load.status === "error" && (
        <Alert variant="severe" className="m-4">
          <AlertDescription>
            Your devices are not available right now. Try again shortly.
          </AlertDescription>
        </Alert>
      )}

      {load.status === "ready" && load.devices.length === 0 && (
        <p className="px-4 py-4 text-sm text-text-secondary">
          No signed-in devices found.
        </p>
      )}

      {load.status === "ready" && load.devices.length > 0 && (
        <ul>
          {load.devices.map((d) => {
            const Icon = ICONS[d.formFactor];
            const chips =
              d.current && local
                ? [
                    permissionChip("geolocation", local.geolocation),
                    permissionChip("notifications", local.notifications),
                  ]
                : [];
            const hint =
              d.current && local ? blockedHint(local.geolocation) : null;
            return (
              <li
                key={d.id}
                className="flex items-start gap-3 border-b border-border px-4 py-4 last:border-b-0"
              >
                <span
                  className="hoopoe-lg bg-container-sodalite"
                  aria-hidden="true"
                >
                  <Icon className="h-4 w-4 text-on-container-sodalite" />
                </span>
                <div className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-text-primary">
                    {d.label}
                    {d.current && (
                      <Badge className="ml-2 rounded-full px-2 text-xs">
                        This device{standalone ? " · app" : ""}
                      </Badge>
                    )}
                  </span>
                  <span className="text-xs text-text-secondary">
                    {d.current
                      ? "Active now"
                      : now !== null
                        ? lastActiveLabel(d.lastActiveAt, now)
                        : "Active recently"}
                  </span>
                  {chips.length > 0 && (
                    <ul
                      aria-label="Permissions"
                      className="mt-2 flex flex-wrap gap-1.5"
                    >
                      {chips.map((c) => (
                        <li
                          key={c}
                          className="rounded-full bg-surface-dim px-2 py-0.5 font-mono text-xs text-text-secondary"
                        >
                          {c}
                        </li>
                      ))}
                    </ul>
                  )}
                  {hint && (
                    <p className="mt-1 text-xs text-text-tertiary">{hint}</p>
                  )}
                  {d.current && (
                    <p className="mt-1 text-xs text-text-tertiary">
                      {preferencesSummary({
                        theme,
                        savedLocations,
                        selectedActivities,
                        selectedForecastModel: "",
                        homeLocation: null,
                      })}
                    </p>
                  )}
                </div>
                {!d.current && (
                  <button
                    type="button"
                    onClick={() => void signOut(d.id)}
                    disabled={busyId === d.id}
                    aria-busy={busyId === d.id}
                    aria-label={`Sign out ${d.label}`}
                    className="impala-sm shrink-0"
                  >
                    {busyId === d.id ? "Signing out…" : "Sign out"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {problem && (
        <Alert variant="warning" className="mx-4 mb-4">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
    </ProfileGroup>
  );
}
