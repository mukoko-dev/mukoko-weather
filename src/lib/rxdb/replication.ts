/**
 * RxDB replication to the Python backend.
 *
 * Preferences: bidirectional (push to PATCH /v1/devices/{id}, pull from GET /v1/devices/{id} on the Rust Worker;
 * a 404 creates the profile once with POST /v1/devices, see device-profile.ts)
 * Suitability rules: pull-only (GET /v1/suitability on the Rust Worker every 10 min)
 *
 * Uses leader election — only the leader tab replicates to avoid conflicts.
 */

import {
  replicateRxCollection,
  type RxReplicationState,
} from "rxdb/plugins/replication";
import {
  preferencesCollection,
  suitabilityRulesCollection,
} from "./collections";
import { fetchWorker } from "../weather-api";
import { getDeviceId } from "./bridge";
import { isPersonSyncActive } from "../person-preferences-state";
import {
  createDeviceProfileClient,
  type DevicePrefsBody,
} from "./device-profile";
import type { PreferencesDocType } from "./schemas";
import { sanitiseNotificationPrefs } from "../notification-prefs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RULES_PULL_INTERVAL_MS = 10 * 60_000; // 10 min

// ---------------------------------------------------------------------------
// Replication state
// ---------------------------------------------------------------------------

let prefsReplication: RxReplicationState<PreferencesDocType, unknown> | null =
  null;
let rulesRefreshTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Preferences replication (bidirectional)
// ---------------------------------------------------------------------------

/** The slice of a preferences document the Worker's profile carries. */
function toPrefsBody(prefs: PreferencesDocType): DevicePrefsBody {
  return {
    theme: prefs.theme,
    selectedLocation: prefs.selectedLocation,
    savedLocations: prefs.savedLocations,
    locationLabels: prefs.locationLabels,
    selectedActivities: prefs.selectedActivities,
    hasOnboarded: prefs.hasOnboarded,
    selectedForecastModel: prefs.selectedForecastModel,
  };
}

async function startPrefsReplication(): Promise<void> {
  const col = await preferencesCollection();
  if (!col) return;

  const deviceId = getDeviceId();
  // Creates the device's profile on the Worker the first time it is missing
  // (a 404), backs off on failure and never loops on a 404 (device-profile.ts).
  const profile = createDeviceProfileClient({
    deviceId,
    localPrefs: async () => {
      const local = await col.findOne(deviceId).exec();
      return local ? toPrefsBody(local) : null;
    },
  });

  prefsReplication = replicateRxCollection<PreferencesDocType, unknown>({
    collection: col,
    replicationIdentifier: `mukoko-prefs-${deviceId}`,
    autoStart: true,
    retryTime: 5000, // retry every 5s on failure
    waitForLeadership: true, // only leader tab replicates

    push: {
      batchSize: 1,
      handler: async (changeRows) => {
        for (const row of changeRows) {
          if (!row.newDocumentState) continue;
          // Throws when the push should be retried later (offline, a failing
          // Worker, backing off); RxDB then calls this handler again.
          await profile.push(toPrefsBody(row.newDocumentState));
        }
        return [];
      },
    },

    pull: {
      // Checkpoint intentionally discarded — the device profile is a single
      // small document, not a paginated collection. Every pull fetches the
      // full profile, so incremental pull optimization doesn't apply here.
      handler: async (_lastCheckpoint, _batchSize) => {
        try {
          const server = await profile.pull();
          const serverPrefs = server?.preferences;
          if (!serverPrefs) return { documents: [], checkpoint: null };

          // homeLocation is device-local until the device profile API carries
          // it, so keep the local value rather than letting the pull null it.
          const localDoc = await col.findOne(deviceId).exec();

          const doc = {
            id: deviceId,
            theme: serverPrefs.theme ?? "system",
            selectedLocation: serverPrefs.selectedLocation ?? "",
            savedLocations: serverPrefs.savedLocations ?? [],
            locationLabels: serverPrefs.locationLabels ?? {},
            // While a signed-in person's activities are synced to their
            // profile (person-preferences-sync.ts) this device-profile pull
            // must not write them: it would overwrite what the person chose
            // here with an older copy, and the profile sync would then record
            // that as their removal. The push above is unchanged.
            selectedActivities:
              isPersonSyncActive() && localDoc
                ? localDoc.selectedActivities
                : (serverPrefs.selectedActivities ?? []),
            hasOnboarded: serverPrefs.hasOnboarded ?? false,
            selectedForecastModel:
              serverPrefs.selectedForecastModel ?? "best_match",
            homeLocation: localDoc?.homeLocation ?? null,
            // Suggested-place state is device-local too (see schemas.ts).
            hiddenPresetSlugs: localDoc?.hiddenPresetSlugs ?? [],
            presetAnchor: localDoc?.presetAnchor ?? null,
            // Alert preferences are device-local too (see schemas.ts).
            notificationPrefs: sanitiseNotificationPrefs(
              localDoc?.notificationPrefs,
            ),
            updatedAt: Date.now(),
            _deleted: false,
          };

          return { documents: [doc], checkpoint: null };
        } catch {
          return { documents: [], checkpoint: null };
        }
      },
      batchSize: 1,
      // Polling-only replication — no real-time stream. RxDB requires the
      // stream$ property to exist; EMPTY (completes immediately) satisfies
      // the Observable contract without the unsafe `as never` cast.
      stream$: new (await import("rxjs")).Subject(),
    },
  });
}

// ---------------------------------------------------------------------------
// Suitability rules refresh (pull-only, not RxDB replication)
// ---------------------------------------------------------------------------

export async function refreshSuitabilityRules(): Promise<void> {
  const col = await suitabilityRulesCollection();
  if (!col) return;

  try {
    const res = await fetchWorker("suitability", "");
    if (!res.ok) return;

    const data = await res.json();
    const rules = data?.rules;
    if (!Array.isArray(rules) || rules.length === 0) return;

    const now = Date.now();
    for (const rule of rules) {
      if (!rule.key) continue;
      await col.upsert({
        key: rule.key,
        conditions: JSON.stringify(rule.conditions ?? []),
        updatedAt: now,
      });
    }
  } catch {
    // Network error — use stale cache
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start all replication handlers.
 * Call once after RxDB bridge is initialized.
 */
export async function startReplication(): Promise<void> {
  // Replication is an optional sync enhancement — any RxDB/replication failure
  // must never crash the app or bubble into render.
  try {
    await startPrefsReplication();
  } catch (err) {
    console.warn("[RxDB] prefs replication failed to start:", String(err));
  }

  // Initial rules fetch (already internally guarded)
  await refreshSuitabilityRules();

  // Periodic rules refresh
  if (!rulesRefreshTimer) {
    rulesRefreshTimer = setInterval(
      refreshSuitabilityRules,
      RULES_PULL_INTERVAL_MS,
    );
  }
}

/**
 * Stop all replication (for cleanup/testing).
 */
export async function stopReplication(): Promise<void> {
  try {
    if (prefsReplication) {
      await prefsReplication.cancel();
      prefsReplication = null;
    }
  } catch {
    // best-effort teardown
    prefsReplication = null;
  }

  if (rulesRefreshTimer) {
    clearInterval(rulesRefreshTimer);
    rulesRefreshTimer = null;
  }
}
