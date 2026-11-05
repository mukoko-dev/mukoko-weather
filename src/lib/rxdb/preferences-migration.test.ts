/**
 * The preferences schema bump (v3 to v4, `notificationPrefs`) against the REAL
 * database wiring: an IndexedDB (fake-indexeddb) that already holds a v3
 * document, opened through `getDatabase()` exactly as the app does. A broken
 * migration would not throw at the person: `createDbSafe` turns it into
 * "RxDB unavailable" and the app falls back to localStorage for good, so the
 * migration is worth running for real, not only as a function.
 */
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_NOTIFICATION_PREFS } from "../notification-prefs";
import { preferencesSchema } from "./schemas";

const V3_DOC = {
  id: "device-1",
  theme: "dark",
  selectedLocation: "harare",
  savedLocations: ["bulawayo", "mutare"],
  locationLabels: { bulawayo: "Work" },
  selectedActivities: ["farming"],
  hasOnboarded: true,
  selectedForecastModel: "gfs_seamless",
  homeLocation: "harare",
  hiddenPresetSlugs: ["nairobi-ke"],
  presetAnchor: { lat: -17.8, lon: 31.05 },
  updatedAt: 1234,
};

describe("real RxDB: a stored v3 preferences document opens at v4", () => {
  it("keeps every field and adds the notification defaults", async () => {
    vi.stubGlobal("window", globalThis);
    const [{ addRxPlugin, createRxDatabase }, migration, dexie] =
      await Promise.all([
        import("rxdb"),
        import("rxdb/plugins/migration-schema"),
        import("rxdb/plugins/storage-dexie"),
      ]);
    addRxPlugin(migration.RxDBMigrationSchemaPlugin);

    // The v3 schema as it shipped: today's, without notificationPrefs.
    const { notificationPrefs: _added, ...v3Properties } =
      preferencesSchema.properties;
    void _added;
    const v3Schema = {
      ...preferencesSchema,
      version: 3,
      properties: v3Properties,
      required: (preferencesSchema.required ?? []).filter(
        (key) => key !== "notificationPrefs",
      ),
    };

    const before = await createRxDatabase({
      name: "mukoko_weather",
      storage: dexie.getRxStorageDexie(),
      multiInstance: false,
    });
    const identity = (doc: unknown) => doc;
    await before.addCollections({
      preferences: {
        schema: v3Schema as never,
        migrationStrategies: { 1: identity, 2: identity, 3: identity },
      },
    });
    await before.preferences.insert(V3_DOC as never);
    await before.close();

    const { getDatabase } = await import("./database");
    const db = await getDatabase();
    expect(db, "the migration must not leave RxDB unavailable").not.toBeNull();
    const doc = await db!.preferences.findOne("device-1").exec();
    expect(doc).not.toBeNull();
    expect(doc!.toJSON()).toMatchObject({
      ...V3_DOC,
      notificationPrefs: DEFAULT_NOTIFICATION_PREFS,
    });

    // The new field is writable as the app writes it, and reads back.
    await doc!.incrementalPatch({
      notificationPrefs: {
        ...DEFAULT_NOTIFICATION_PREFS,
        frost: false,
        quietStart: 22,
        quietEnd: 6,
      },
    });
    const again = await db!.preferences.findOne("device-1").exec();
    expect(again!.notificationPrefs).toMatchObject({
      frost: false,
      quietStart: 22,
      quietEnd: 6,
    });
    await db!.close();
    vi.unstubAllGlobals();
  });
});
