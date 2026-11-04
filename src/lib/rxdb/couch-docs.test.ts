import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTIVITIES } from "../activities";
import { ForecastModel } from "../weather";
import {
  OPEN_METEO_MODEL_OPTIONS,
  modelOptions,
} from "../forecast-model-options";
import {
  ACTIVITY_ID_RE,
  COUCH_DOC_SCHEMA_VERSION,
  LOCAL_ONLY_FORECAST_MODELS,
  MAX_SYNCED_ACTIVITIES,
  SYNCED_FORECAST_MODELS,
  SYNCED_PREFERENCE_KEYS,
  THEME_VALUES,
  activityDocId,
  assertPlaintextDoc,
  isDeviceId,
  isKnownActivityId,
  isOwnedDocId,
  isWellFormedDoc,
  ownedDocIds,
  patchFromDocs,
  pickWireFields,
  planChangeOps,
  planSeedOps,
  preferenceDocId,
  resolveUserDocConflict,
  toPullDoc,
  toPushDoc,
  toRfc3339,
  tombstoneWire,
  type DocContext,
  type SyncableState,
  type UserDocType,
} from "./couch-docs";
import {
  validateDoc,
  validatorForecastModels,
  validatorPreferenceKeys,
  validatorThemeValues,
  validatorTypes,
  type Json,
} from "./test-support/couch-validator-facts";

const PERSON = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const DEVICE = "11111111-2222-4333-8444-555555555555";
/** The same shape with upper-case hex digits, which the validator refuses. */
const UPPER_DEVICE = "ABCDEF01-2222-4333-8444-555555555555";
const T0 = Date.parse("2026-11-02T10:00:00.000Z");
/** The CouchDB server's clock in these tests: an hour after the first write. */
const SERVER_NOW = () => T0 + 3_600_000;
const ctx = (nowMs = T0): DocContext => ({ deviceId: DEVICE, nowMs });
const state = (over: Partial<SyncableState> = {}): SyncableState => ({
  theme: "system",
  selectedForecastModel: "best_match",
  selectedActivities: [],
  ...over,
});

/**
 * The document as CouchDB would receive it from the replication: what the push
 * modifier makes of it, with RxDB's `id` turned into `_id` (the plugin does
 * that). Null when the modifier skips the row.
 */
function wireOf(doc: UserDocType & { _deleted?: boolean }): Json | null {
  const wire = toPushDoc(doc);
  if (!wire) return null;
  const { id, ...rest } = wire;
  return { _id: id, ...rest };
}

/** The pinned CouchDB validator is the judge of every document we make. */
function verdictOf(doc: UserDocType & { _deleted?: boolean }) {
  const wire = wireOf(doc);
  if (!wire) throw new Error("the push modifier skipped the document");
  return validateDoc(wire, { personId: PERSON, serverNowMs: SERVER_NOW });
}

function upserts(ops: ReturnType<typeof planChangeOps>): UserDocType[] {
  return ops.flatMap((o) => (o.kind === "upsert" ? [o.doc] : []));
}

describe("ids and vocabulary", () => {
  it("owns activity ids and the two synced settings, nothing else", () => {
    expect(isOwnedDocId("activity:crop-farming")).toBe(true);
    expect(isOwnedDocId("preference:theme")).toBe(true);
    expect(isOwnedDocId("preference:forecastModel")).toBe(true);
    for (const id of [
      "preference:homePlace",
      "preference:language",
      "preference:temperatureUnit",
      "savedPlace:0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
      "interest:x",
      "historyEntry:x",
      "engagementEvent:x",
      "deviceNote:x",
      "activity:Bad_Id",
      "activity:",
      "_design/nyuchi",
      "_local/x",
      "",
      42,
      null,
    ]) {
      expect(isOwnedDocId(id), String(id)).toBe(false);
    }
  });

  it("the document types and settings this client writes are ones the validator lists", () => {
    expect(validatorTypes()).toEqual(
      expect.arrayContaining(["preference", "activity"]),
    );
    expect(validatorPreferenceKeys()).toEqual(
      expect.arrayContaining([...SYNCED_PREFERENCE_KEYS]),
    );
    // `homePlace` is in the validator's id pattern but is a ciphertext-only
    // setting (it needs an envelope); it is not a plaintext key, and never ours.
    expect(validatorPreferenceKeys()).not.toContain("homePlace");
    expect([...THEME_VALUES].sort()).toEqual(
      [...validatorThemeValues()].sort(),
    );
  });

  describe("the forecast models that sync are the validator's, as far as the app offers them", () => {
    const REPO = join(__dirname, "..", "..", "..");
    const read = (...p: string[]) => readFileSync(join(REPO, ...p), "utf8");
    /** The quoted values of a Rust `const NAME: [&str; N] = [ ... ];`. */
    const rustList = (source: string, name: string): string[] => {
      const start = source.indexOf(`pub const ${name}`);
      expect(start, name).toBeGreaterThan(-1);
      const body = source.slice(
        source.indexOf("= [", start),
        source.indexOf("];", start),
      );
      return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    };
    const offeredByApp = Object.values(ForecastModel) as string[];

    it("are exactly the validator's enum (parsed from the pinned file) that the My Weather picker offers", () => {
      const expected = validatorForecastModels().filter((m) =>
        offeredByApp.includes(m),
      );
      expect(expected.length).toBeGreaterThan(3);
      expect([...SYNCED_FORECAST_MODELS].sort()).toEqual([...expected].sort());
    });

    it("the picks the validator does not list stay on the device (local only), and nothing else does", () => {
      const notListed = offeredByApp.filter(
        (m) => !validatorForecastModels().includes(m),
      );
      expect([...LOCAL_ONLY_FORECAST_MODELS].sort()).toEqual(
        [...notListed].sort(),
      );
      // Today that is the Météo-France pick and Apple Weather (the validator's
      // enum is the gateway's, and Apple is served by another provider, behind
      // a feature flag); a test that says so, so adding either to the data model
      // (or removing the pick) is noticed.
      expect([...LOCAL_ONLY_FORECAST_MODELS].sort()).toEqual([
        "apple_weatherkit",
        "meteofrance_seamless",
      ]);
    });

    it("Apple Weather is never synced: not in the synced list, not in the validator's enum", () => {
      expect(SYNCED_FORECAST_MODELS as readonly string[]).not.toContain(
        ForecastModel.AppleWeatherKit,
      );
      expect(validatorForecastModels()).not.toContain(
        ForecastModel.AppleWeatherKit,
      );
      expect(LOCAL_ONLY_FORECAST_MODELS).toContain(
        ForecastModel.AppleWeatherKit,
      );
    });

    it("synced and local-only together are exactly what the picker's radio group renders, Apple Weather's row (behind its flag) included", () => {
      // The picker renders its rows from `modelOptions()`; the radio group in
      // MyWeatherModal must keep doing so (the rows are not retyped there).
      const modal = read("src", "components", "weather", "MyWeatherModal.tsx");
      expect(modal).toContain('from "@/lib/forecast-model-options"');
      expect(modal).toContain("const options = modelOptions();");
      expect(modal).toContain("options.map((option) =>");

      const always = OPEN_METEO_MODEL_OPTIONS.map((o) => o.value as string);
      const withApple = modelOptions(true).map((o) => o.value as string);
      const withoutApple = modelOptions(false).map((o) => o.value as string);
      expect(always.length).toBeGreaterThan(3);
      // Flag off (the shipped state): every model but Apple's.
      expect(withoutApple).toEqual(always);
      expect(withoutApple).not.toContain(ForecastModel.AppleWeatherKit);
      // Flag on: Apple Weather's row too, and then the rows are exactly the
      // synced picks plus the local-only ones.
      expect(withApple).toEqual([...always, ForecastModel.AppleWeatherKit]);
      expect([...withApple].sort()).toEqual(
        [...SYNCED_FORECAST_MODELS, ...LOCAL_ONLY_FORECAST_MODELS].sort(),
      );
    });

    it("are each accepted by the device-profile allowlist of the Worker, so a synced pick never makes /v1/devices answer 400", () => {
      const worker = rustList(
        read("workers", "crates", "weather-core", "src", "community.rs"),
        "FORECAST_MODELS",
      );
      expect(worker.length).toBeGreaterThan(5);
      for (const model of SYNCED_FORECAST_MODELS) {
        expect(worker, model).toContain(model);
      }
    });

    it("the Worker's list (12) and the validator's (10) differ, and this is how (a follow-up, not something this client papers over)", () => {
      const worker = rustList(
        read("workers", "crates", "weather-core", "src", "community.rs"),
        "FORECAST_MODELS",
      );
      const validator = validatorForecastModels();
      expect(worker.filter((m) => !validator.includes(m)).sort()).toEqual([
        "apple_weatherkit",
        "ecmwf_ifs025",
        "ecmwf_ifs04",
        "icon_seamless",
        "meteofrance_seamless",
      ]);
      expect(validator.filter((m) => !worker.includes(m)).sort()).toEqual([
        "cma_grapes_global",
        "jma_gsm",
        "ukmo_global_deterministic_10km",
      ]);
    });

    it.each([
      "jma_gsm",
      "ukmo_global_deterministic_10km",
      "cma_grapes_global",
      "gem_global",
      "meteofrance_arpege_world",
    ])(
      "%s, which the validator lists and another client may set, is not a value of this app",
      (model) => {
        expect(validatorForecastModels()).toContain(model);
        expect(SYNCED_FORECAST_MODELS as readonly string[]).not.toContain(
          model,
        );
      },
    );
  });

  it("every activity id the app ships fits the data model's id pattern", async () => {
    const source = readFileSync(join(__dirname, "..", "activities.ts"), "utf8");
    const ids = [...source.matchAll(/^\s+id: "([^"]+)",\s*$/gm)].map(
      (m) => m[1],
    );
    expect(ids.length).toBeGreaterThan(40);
    const bad = ids.filter((id) => !ACTIVITY_ID_RE.test(id));
    expect(bad).toEqual([]);
  });

  it("RFC 3339 times always have three fractional digits and a Z", () => {
    expect(toRfc3339(T0)).toBe("2026-11-02T10:00:00.000Z");
    expect(toRfc3339(T0 + 7)).toBe("2026-11-02T10:00:00.007Z");
  });

  it("the device id is a lower-case UUID, as the validator wants", () => {
    expect(isDeviceId(DEVICE)).toBe(true);
    for (const bad of [UPPER_DEVICE, "device-1", "", `${DEVICE}0`, 42, null]) {
      expect(isDeviceId(bad), String(bad)).toBe(false);
    }
  });

  it("the database name rule lives in the contract module, not here", () => {
    expect(readFileSync(join(__dirname, "couch-docs.ts"), "utf8")).not.toMatch(
      /personIdFromDatabase|PERSONAL_DB_RE/,
    );
  });

  it("the person's id is not in any document: the database name is the ownership", () => {
    const code = readFileSync(join(__dirname, "couch-docs.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/ownerPersonId|personId/);
  });
});

describe("the pinned validator accepts every document this client writes", () => {
  it("a theme change, whatever the value", () => {
    for (const value of THEME_VALUES) {
      const [doc] = upserts(
        planChangeOps(
          state({ theme: value === "dark" ? "light" : "dark" }),
          state({ theme: value }),
          new Map(),
          ctx(),
        ),
      );
      expect(doc, value).toMatchObject({
        id: "preference:theme",
        type: "preference",
        preferenceKey: "theme",
        preferenceValue: value,
        schemaVersion: "v3.1",
        deviceId: DEVICE,
        createdAt: "2026-11-02T10:00:00.000Z",
        updatedAt: "2026-11-02T10:00:00.000Z",
      });
      expect(isWellFormedDoc(doc), value).toBe(true);
      expect(verdictOf(doc), value).toEqual({ ok: true });
    }
  });

  it("every forecast model it syncs", () => {
    expect(SYNCED_FORECAST_MODELS.length).toBeGreaterThan(3);
    for (const model of SYNCED_FORECAST_MODELS) {
      const docs = upserts(
        planChangeOps(
          state({ selectedForecastModel: "x" }),
          state({ selectedForecastModel: model }),
          new Map(),
          ctx(),
        ),
      );
      expect(
        docs.map((d) => d.preferenceValue),
        model,
      ).toEqual([model]);
      expect(verdictOf(docs[0]), model).toEqual({ ok: true });
    }
  });

  it("every setting key the engine syncs, by the seed path as well as by a change", () => {
    const seeded = upserts(
      planSeedOps(
        state({ theme: "dark", selectedForecastModel: "gfs_seamless" }),
        new Set(),
        ctx(),
      ),
    );
    expect(seeded.map((d) => d.preferenceKey).sort()).toEqual(
      [...SYNCED_PREFERENCE_KEYS].sort(),
    );
    for (const d of seeded) expect(verdictOf(d), d.id).toEqual({ ok: true });
  });

  it("every activity the app offers", () => {
    const ids = ACTIVITIES.map((a) => a.id);
    const docs = upserts(
      planChangeOps(
        state(),
        state({ selectedActivities: ids }),
        new Map(),
        ctx(),
      ),
    );
    expect(docs).toHaveLength(ids.length);
    for (const d of docs) {
      expect(d.activityId).toBeDefined();
      expect(verdictOf(d), d.id).toEqual({ ok: true });
    }
    // ...and the same ids by the seed path.
    for (const d of upserts(
      planSeedOps(state({ selectedActivities: ids }), new Set(), ctx()),
    )) {
      expect(verdictOf(d), d.id).toEqual({ ok: true });
    }
  });

  it("the wire form of a document has exactly the fields of its type, and none of the old contract's", () => {
    const [doc] = upserts(
      planChangeOps(
        state(),
        state({ selectedActivities: ["livestock"] }),
        new Map(),
        ctx(),
      ),
    );
    const wire = pickWireFields({ ...doc, secretNote: "x" } as UserDocType);
    expect(Object.keys(wire).sort()).toEqual(
      [
        "_deleted",
        "activityId",
        "createdAt",
        "deviceId",
        "id",
        "schemaVersion",
        "type",
        "updatedAt",
      ].sort(),
    );
    expect(wire.schemaVersion).toBe("v3.1");
    expect("ownerPersonId" in wire).toBe(false);
  });

  it("a deletion carries the common fields and nothing else, and the validator accepts it", () => {
    const [live] = upserts(
      planChangeOps(
        state(),
        state({ selectedActivities: ["livestock"] }),
        new Map(),
        ctx(T0),
      ),
    );
    // What RxDB holds after the engine's tombstone: the live document with the
    // time and the install of the deletion, flagged deleted.
    const deleted = {
      ...live,
      updatedAt: toRfc3339(T0 + 5_000),
      deviceId: DEVICE,
      _deleted: true as const,
    };
    const wire = tombstoneWire(deleted);
    expect(wire).toEqual({
      id: "activity:livestock",
      type: "activity",
      schemaVersion: "v3.1",
      deviceId: DEVICE,
      createdAt: toRfc3339(T0),
      updatedAt: toRfc3339(T0 + 5_000),
      _deleted: true,
    });
    // No activityId (or preferenceKey, preferenceValue): the validator refuses it.
    expect("activityId" in (wire as object)).toBe(false);
    expect(verdictOf(deleted)).toEqual({ ok: true });
    // The same for a deleted setting.
    const [pref] = upserts(
      planChangeOps(state(), state({ theme: "dark" }), new Map(), ctx(T0)),
    );
    const prefWire = tombstoneWire({ ...pref, _deleted: true } as never);
    expect(Object.keys(prefWire as object).sort()).toEqual(
      [
        "_deleted",
        "createdAt",
        "deviceId",
        "id",
        "schemaVersion",
        "type",
        "updatedAt",
      ].sort(),
    );
    expect(verdictOf({ ...pref, _deleted: true })).toEqual({ ok: true });
  });

  it("a tombstone that cannot carry the common fields is not pushed", () => {
    expect(tombstoneWire({ id: "activity:livestock" })).toBeNull();
    const [live] = upserts(
      planChangeOps(
        state(),
        state({ selectedActivities: ["livestock"] }),
        new Map(),
        ctx(),
      ),
    );
    expect(toPushDoc({ ...live, deviceId: "not-a-uuid", _deleted: true })).toBe(
      null,
    );
    expect(toPushDoc({ ...live, updatedAt: "yesterday", _deleted: true })).toBe(
      null,
    );
  });

  describe("and refuses the old contract's shapes, so the tests would notice a regression to them", () => {
    const base = (): Json => ({
      _id: "activity:livestock",
      type: "activity",
      schemaVersion: "v3.1",
      deviceId: DEVICE,
      createdAt: toRfc3339(T0),
      updatedAt: toRfc3339(T0),
      activityId: "livestock",
    });
    const verdict = (doc: Json) =>
      validateDoc(doc, { personId: PERSON, serverNowMs: SERVER_NOW });

    it("the baseline document is accepted", () => {
      expect(verdict(base())).toEqual({ ok: true });
    });

    it("an integer schemaVersion", () => {
      expect(verdict({ ...base(), schemaVersion: 1 }).ok).toBe(false);
    });

    it("an ownerPersonId (no field outside the type's schema)", () => {
      expect(verdict({ ...base(), ownerPersonId: PERSON })).toMatchObject({
        ok: false,
      });
    });

    it("a stub tombstone (the id and the flag only)", () => {
      expect(verdict({ _id: "activity:livestock", _deleted: true })).toEqual({
        ok: false,
        reason: expect.stringMatching(/unknown document type/),
      });
    });

    it("a tombstone that still carries activityId", () => {
      expect(
        verdict({ ...base(), _deleted: true }).ok,
        "activityId on a tombstone",
      ).toBe(false);
    });

    it("a time that is not exactly YYYY-MM-DDTHH:mm:ss.SSSZ", () => {
      for (const bad of [
        "2026-11-02T10:00:00Z",
        "2026-11-02T10:00:00.5Z",
        "2026-11-02T12:00:00.000+02:00",
        "2026-11-02T10:00:00.000000Z",
      ]) {
        expect(verdict({ ...base(), updatedAt: bad }).ok, bad).toBe(false);
        expect(verdict({ ...base(), createdAt: bad }).ok, bad).toBe(false);
      }
    });

    it("a deviceId that is not a lower-case UUID", () => {
      for (const bad of ["device-1", UPPER_DEVICE, ""]) {
        expect(verdict({ ...base(), deviceId: bad }).ok, bad).toBe(false);
      }
    });

    it("a forecast model outside its enum, Météo-France's included", () => {
      const pref = (value: string): Json => ({
        _id: "preference:forecastModel",
        type: "preference",
        schemaVersion: "v3.1",
        deviceId: DEVICE,
        createdAt: toRfc3339(T0),
        updatedAt: toRfc3339(T0),
        preferenceKey: "forecastModel",
        preferenceValue: value,
      });
      expect(verdict(pref("meteofrance_seamless")).ok).toBe(false);
      expect(verdict(pref("ecmwf_ifs")).ok).toBe(true);
    });

    it("a write into another person's database", () => {
      expect(
        validateDoc(base(), {
          personId: PERSON,
          database: "user_someone-else",
          serverNowMs: SERVER_NOW,
        }),
      ).toMatchObject({ ok: false });
    });

    it("an updatedAt more than a day ahead of the server's clock", () => {
      expect(
        verdict({
          ...base(),
          updatedAt: toRfc3339(SERVER_NOW() + 25 * 3_600_000),
        }).ok,
      ).toBe(false);
      expect(
        verdict({
          ...base(),
          updatedAt: toRfc3339(SERVER_NOW() + 23 * 3_600_000),
        }).ok,
      ).toBe(true);
    });
  });
});

describe("the plaintext gate", () => {
  const base: UserDocType = {
    id: "preference:theme",
    type: "preference",
    schemaVersion: COUCH_DOC_SCHEMA_VERSION,
    deviceId: DEVICE,
    createdAt: toRfc3339(T0),
    updatedAt: toRfc3339(T0),
    preferenceKey: "theme",
    preferenceValue: "dark",
  };

  it("passes the two owned types", () => {
    expect(() => assertPlaintextDoc(base)).not.toThrow();
    expect(() =>
      assertPlaintextDoc({
        ...base,
        id: "activity:livestock",
        type: "activity",
        activityId: "livestock",
        preferenceKey: undefined,
        preferenceValue: undefined,
      }),
    ).not.toThrow();
  });

  it("refuses the locational setting, other types, bad values and anything the validator would refuse", () => {
    const refused: Partial<UserDocType>[] = [
      { id: "preference:homePlace", preferenceKey: "homePlace" as never },
      { id: "savedPlace:abc", type: "savedPlace" as never },
      { id: "interest:abc", type: "interest" as never },
      { id: "historyEntry:abc", type: "historyEntry" as never },
      { preferenceValue: "purple" },
      { id: "preference:language", preferenceKey: "language" as never },
      // The app's own pick that the validator's enum does not list.
      {
        id: "preference:forecastModel",
        preferenceKey: "forecastModel",
        preferenceValue: "meteofrance_seamless",
      },
      // ...and a value that fits the enum but not this app's pickers.
      {
        id: "preference:forecastModel",
        preferenceKey: "forecastModel",
        preferenceValue: "jma_gsm",
      },
      { schemaVersion: 1 as never },
      { schemaVersion: "v2.0" },
      { deviceId: "device-1" },
      { deviceId: UPPER_DEVICE },
      { updatedAt: "2026-11-02T10:00:00Z" },
      { createdAt: "2026-11-02T12:00:00.000+02:00" },
      { activityId: "livestock" }, // a preference that carries an activityId
    ];
    for (const over of refused) {
      expect(() => assertPlaintextDoc({ ...base, ...over })).toThrow(
        /couch-sync/,
      );
    }
    // An activity whose id and activityId disagree.
    expect(() =>
      assertPlaintextDoc({
        ...base,
        id: "activity:livestock",
        type: "activity",
        preferenceKey: undefined,
        preferenceValue: undefined,
        activityId: "gardening",
      }),
    ).toThrow(/couch-sync/);
  });

  it("whatever the gate lets through, the validator accepts (the gate is not looser than it)", () => {
    const candidates: UserDocType[] = [];
    for (const v of THEME_VALUES) {
      candidates.push({ ...base, preferenceValue: v });
    }
    for (const m of SYNCED_FORECAST_MODELS) {
      candidates.push({
        ...base,
        id: "preference:forecastModel",
        preferenceKey: "forecastModel",
        preferenceValue: m,
      });
    }
    for (const a of ACTIVITIES) {
      candidates.push({
        id: activityDocId(a.id),
        type: "activity",
        schemaVersion: COUCH_DOC_SCHEMA_VERSION,
        deviceId: DEVICE,
        createdAt: toRfc3339(T0),
        updatedAt: toRfc3339(T0),
        activityId: a.id,
      });
    }
    for (const d of candidates) {
      expect(isWellFormedDoc(d), d.id).toBe(true);
      expect(verdictOf(d), d.id).toEqual({ ok: true });
    }
  });

  describe("the push modifier", () => {
    it("reduces a live document to the wire fields", () => {
      const wire = toPushDoc({ ...base, secret: "x" } as UserDocType);
      expect(wire).not.toBeNull();
      expect(wire).toMatchObject({
        id: "preference:theme",
        preferenceKey: "theme",
        preferenceValue: "dark",
        schemaVersion: "v3.1",
      });
      expect("secret" in (wire as object)).toBe(false);
    });

    it("skips an id this client does not own, instead of sending it or throwing", () => {
      expect(
        toPushDoc({
          ...base,
          id: "preference:homePlace",
          preferenceKey: "homePlace" as never,
        }),
      ).toBeNull();
      expect(toPushDoc({ ...base, id: "savedPlace:x" })).toBeNull();
    });

    it("turns a deleted document into its tombstone", () => {
      expect(toPushDoc({ ...base, _deleted: true })).toEqual({
        id: "preference:theme",
        type: "preference",
        schemaVersion: "v3.1",
        deviceId: DEVICE,
        createdAt: toRfc3339(T0),
        updatedAt: toRfc3339(T0),
        _deleted: true,
      });
    });

    it("lets the assumed master through by shape: a model another client set does not stop the edit of that setting", () => {
      // The plugin applies the modifier to the assumed master state of every row
      // too. A forecast model that only another client offers (the validator
      // lists it, this app does not) is the server's to have written; throwing
      // or skipping on it would wedge the push of this client's own edit.
      const master = {
        ...base,
        id: "preference:forecastModel",
        preferenceKey: "forecastModel",
        preferenceValue: "jma_gsm",
      } as UserDocType;
      const wire = toPushDoc(master);
      expect(wire).toMatchObject({ preferenceValue: "jma_gsm" });
      expect(() => toPushDoc(master)).not.toThrow();
    });
  });

  describe("the pull modifier", () => {
    it("strips fields this client does not know", () => {
      const pulled = toPullDoc({
        ...base,
        _deleted: false,
        secret: "from another client",
        envelope: { ciphertext: "x" },
      } as UserDocType & { _deleted: boolean });
      expect("secret" in pulled).toBe(false);
      expect("envelope" in pulled).toBe(false);
    });

    it("keeps a tombstone's common fields, which its ordering against an edit needs", () => {
      const pulled = toPullDoc({
        ...base,
        id: "activity:livestock",
        type: "activity",
        activityId: "livestock",
        _deleted: true,
      } as never);
      expect(pulled).toMatchObject({
        id: "activity:livestock",
        type: "activity",
        updatedAt: toRfc3339(T0),
        deviceId: DEVICE,
        _deleted: true,
      });
      expect("activityId" in pulled).toBe(false);
    });

    it("a stub tombstone (nothing else on it) still deletes", () => {
      expect(toPullDoc({ id: "activity:x", _deleted: true })).toEqual({
        id: "activity:x",
        _deleted: true,
      });
    });
  });
});

describe("state -> documents", () => {
  it("writes nothing for a setting that did not change", () => {
    expect(planChangeOps(state(), state(), new Map(), ctx())).toEqual([]);
  });

  it("selecting writes a document, unselecting a tombstone, only if one exists", () => {
    const added = planChangeOps(
      state(),
      state({ selectedActivities: ["livestock"] }),
      new Map(),
      ctx(),
    );
    expect(added).toHaveLength(1);
    const doc = upserts(added)[0];

    const removedNoDoc = planChangeOps(
      state({ selectedActivities: ["livestock"] }),
      state(),
      new Map(),
      ctx(),
    );
    expect(removedNoDoc).toEqual([]);

    const removed = planChangeOps(
      state({ selectedActivities: ["livestock"] }),
      state(),
      new Map([[doc.id, doc]]),
      ctx(),
    );
    expect(removed).toEqual([{ kind: "tombstone", id: "activity:livestock" }]);
  });

  it("keeps createdAt of an existing document and moves updatedAt", () => {
    const [first] = upserts(
      planChangeOps(state(), state({ theme: "dark" }), new Map(), ctx(T0)),
    );
    const [second] = upserts(
      planChangeOps(
        state({ theme: "dark" }),
        state({ theme: "light" }),
        new Map([[first.id, first]]),
        ctx(T0 + 60_000),
      ),
    );
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe(toRfc3339(T0 + 60_000));
    expect(second.preferenceValue).toBe("light");
  });

  it("writes the createdAt of an existing document in the one form the validator accepts", () => {
    const [first] = upserts(
      planChangeOps(state(), state({ theme: "dark" }), new Map(), ctx(T0)),
    );
    const [second] = upserts(
      planChangeOps(
        state({ theme: "dark" }),
        state({ theme: "light" }),
        // A document another client made, in an RFC 3339 form the validator
        // would refuse.
        new Map([
          [first.id, { ...first, createdAt: "2026-11-02T12:00:00+02:00" }],
        ]),
        ctx(T0 + 60_000),
      ),
    );
    expect(second.createdAt).toBe("2026-11-02T10:00:00.000Z");
    expect(verdictOf(second)).toEqual({ ok: true });
  });

  it("never writes a value the data model does not allow, or an unsyncable id", () => {
    const ops = planChangeOps(
      state(),
      state({
        theme: "purple",
        // A model another client knows and this app does not offer.
        selectedForecastModel: "jma_gsm",
        selectedActivities: ["Not_Valid", "has space"],
      }),
      new Map(),
      ctx(),
    );
    expect(ops).toEqual([]);
  });

  describe("a forecast model the validator does not list stays on the device", () => {
    it("the Météo-France pick is never written", () => {
      expect(
        planChangeOps(
          state(),
          state({ selectedForecastModel: "meteofrance_seamless" }),
          new Map(),
          ctx(),
        ),
      ).toEqual([]);
    });

    it("nor seeded", () => {
      expect(
        planSeedOps(
          state({ selectedForecastModel: "meteofrance_seamless" }),
          new Set(),
          ctx(),
        ),
      ).toEqual([]);
    });

    it("the Apple Weather pick is never written or seeded, whether or not its flag is on (the gateway validator's enum has no such id)", () => {
      expect(
        planChangeOps(
          state(),
          state({ selectedForecastModel: "apple_weatherkit" }),
          new Map(),
          ctx(),
        ),
      ).toEqual([]);
      expect(
        planSeedOps(
          state({ selectedForecastModel: "apple_weatherkit" }),
          new Set(),
          ctx(),
        ),
      ).toEqual([]);
      // Moving to a synced pick from it writes that pick; moving to it from a
      // synced pick writes nothing (the server keeps the last synced one).
      expect(
        upserts(
          planChangeOps(
            state({ selectedForecastModel: "apple_weatherkit" }),
            state({ selectedForecastModel: "gfs_seamless" }),
            new Map(),
            ctx(),
          ),
        ).map((d) => d.preferenceValue),
      ).toEqual(["gfs_seamless"]);
      expect(
        planChangeOps(
          state({ selectedForecastModel: "gfs_seamless" }),
          state({ selectedForecastModel: "apple_weatherkit" }),
          new Map(),
          ctx(),
        ),
      ).toEqual([]);
    });

    it("moving to a synced pick from it writes that pick", () => {
      const docs = upserts(
        planChangeOps(
          state({ selectedForecastModel: "meteofrance_seamless" }),
          state({ selectedForecastModel: "ecmwf_ifs" }),
          new Map(),
          ctx(),
        ),
      );
      expect(docs.map((d) => d.preferenceValue)).toEqual(["ecmwf_ifs"]);
      expect(verdictOf(docs[0])).toEqual({ ok: true });
    });

    it("moving to it from a synced pick writes nothing: the server keeps the last synced one", () => {
      expect(
        planChangeOps(
          state({ selectedForecastModel: "ecmwf_ifs" }),
          state({ selectedForecastModel: "meteofrance_seamless" }),
          new Map(),
          ctx(),
        ),
      ).toEqual([]);
    });
  });
});

describe("seeding: defaults never win", () => {
  it("a fresh device with default settings writes nothing", () => {
    expect(planSeedOps(state(), new Set(), ctx())).toEqual([]);
  });

  it("non-default settings and activities that have no document get one", () => {
    const ops = planSeedOps(
      state({
        theme: "dark",
        selectedForecastModel: "gfs_seamless",
        selectedActivities: ["livestock", "gardening"],
      }),
      new Set(),
      ctx(),
    );
    expect(
      upserts(ops)
        .map((d) => d.id)
        .sort(),
    ).toEqual([
      "activity:gardening",
      "activity:livestock",
      "preference:forecastModel",
      "preference:theme",
    ]);
  });

  it("never touches an id that already has a document, live or deleted", () => {
    const ops = planSeedOps(
      state({ theme: "dark", selectedActivities: ["livestock", "gardening"] }),
      new Set(["preference:theme", "activity:livestock"]),
      ctx(),
    );
    expect(upserts(ops).map((d) => d.id)).toEqual(["activity:gardening"]);
  });

  it("the ids it can have a document for are the two settings and one per activity", () => {
    const ids = ownedDocIds();
    expect(ids).toContain("preference:theme");
    expect(ids).toContain("preference:forecastModel");
    expect(ids.filter((i) => i.startsWith("activity:")).length).toBe(
      ACTIVITIES.length,
    );
    for (const id of ids) expect(isOwnedDocId(id), id).toBe(true);
  });
});

describe("documents -> state", () => {
  const doc = (over: Partial<UserDocType>): UserDocType => ({
    id: "preference:theme",
    type: "preference",
    schemaVersion: COUCH_DOC_SCHEMA_VERSION,
    deviceId: DEVICE,
    createdAt: toRfc3339(T0),
    updatedAt: toRfc3339(T0),
    ...over,
  });
  const theme = (value: string) =>
    doc({ preferenceKey: "theme", preferenceValue: value });
  const act = (id: string, createdMs = T0) =>
    doc({
      id: activityDocId(id),
      type: "activity",
      activityId: id,
      createdAt: toRfc3339(createdMs),
    });

  it("returns only what differs from the current state", () => {
    expect(patchFromDocs([theme("dark")], state({ theme: "dark" }))).toEqual(
      {},
    );
    expect(patchFromDocs([theme("dark")], state())).toEqual({ theme: "dark" });
  });

  it("ignores a value the data model does not allow", () => {
    expect(patchFromDocs([theme("purple")], state())).toEqual({});
  });

  describe("the model version", () => {
    it("reads the same major version (a later minor adds nothing this client uses)", () => {
      expect(
        patchFromDocs([{ ...theme("dark"), schemaVersion: "v3.2" }], state()),
      ).toEqual({ theme: "dark" });
    });

    it.each(["v4.0", "v2.9", "1", "3.1", "", "v3"])(
      "does not read %j",
      (version) => {
        expect(
          patchFromDocs(
            [{ ...theme("dark"), schemaVersion: version }],
            state(),
          ),
        ).toEqual({});
      },
    );

    it("does not read the old numeric version", () => {
      expect(
        patchFromDocs(
          [{ ...theme("dark"), schemaVersion: 1 as never }],
          state(),
        ),
      ).toEqual({});
    });

    it("and an activity of another version is not applied either", () => {
      expect(
        patchFromDocs(
          [{ ...act("livestock"), schemaVersion: "v4.0" }],
          state(),
        ),
      ).toEqual({});
    });
  });

  describe("a forecast model set by another client", () => {
    const model = (value: string) =>
      doc({
        id: "preference:forecastModel",
        preferenceKey: "forecastModel",
        preferenceValue: value,
      });

    it.each(["jma_gsm", "ukmo_global_deterministic_10km", "cma_grapes_global"])(
      "%s is not applied: this app does not offer it",
      (value) => {
        expect(patchFromDocs([model(value)], state())).toEqual({});
      },
    );

    it("never replaces the person's own pick on this device", () => {
      const patch = patchFromDocs(
        [model("jma_gsm")],
        state({ selectedForecastModel: "ecmwf_ifs" }),
      );
      expect(patch.selectedForecastModel).toBeUndefined();
    });

    it("a model this app syncs is applied", () => {
      expect(
        patchFromDocs([model("gfs_seamless")], state()).selectedForecastModel,
      ).toBe("gfs_seamless");
    });

    it("the Météo-France pick is the person's own on this device: no document replaces it, and none is applied for it", () => {
      expect(
        patchFromDocs(
          [model("ecmwf_ifs")],
          state({ selectedForecastModel: "meteofrance_seamless" }),
        ),
      ).toEqual({});
      expect(patchFromDocs([model("meteofrance_seamless")], state())).toEqual(
        {},
      );
    });

    it("the Apple Weather pick is the person's own on this device too: no document replaces it, and none is applied for it", () => {
      expect(
        patchFromDocs(
          [model("ecmwf_ifs")],
          state({ selectedForecastModel: "apple_weatherkit" }),
        ),
      ).toEqual({});
      expect(patchFromDocs([model("apple_weatherkit")], state())).toEqual({});
    });
  });

  describe("activities from another client", () => {
    const REPO = join(__dirname, "..", "..", "..");
    const read = (...p: string[]) => readFileSync(join(REPO, ...p), "utf8");
    const known = ACTIVITIES.map((a) => a.id);

    it("an id the app does not know is ignored, not applied, even when it fits the id pattern", () => {
      const patch = patchFromDocs(
        [act("made-up-activity"), act("livestock", T0 + 1000)],
        state(),
      );
      expect(patch.selectedActivities).toEqual(["livestock"]);
    });

    it("only unknown ids: nothing to apply", () => {
      expect(
        patchFromDocs([act("made-up-activity"), act("other-thing")], state()),
      ).toEqual({});
    });

    it("an unknown id the device holds is left alone, neither dropped nor replaced", () => {
      const patch = patchFromDocs(
        [act("livestock")],
        state({ selectedActivities: ["retired-activity"] }),
      );
      expect(patch.selectedActivities).toEqual([
        "retired-activity",
        "livestock",
      ]);
    });

    it("the activities the app knows are exactly the ones its picker and the Worker know", () => {
      expect(known.length).toBeGreaterThan(40);
      const guidance = JSON.parse(
        read(
          "workers",
          "crates",
          "weather-core",
          "data",
          "reference",
          "activity-guidance.json",
        ),
      ) as Record<string, string>;
      expect(Object.keys(guidance).sort()).toEqual([...known].sort());
      for (const id of known) expect(isKnownActivityId(id), id).toBe(true);
      expect(isKnownActivityId("made-up-activity")).toBe(false);
      expect(isKnownActivityId(42)).toBe(false);
    });

    describe("the device profile holds at most 30", () => {
      it("is the Worker's limit and the app's own", () => {
        expect(
          read("workers", "crates", "weather-core", "src", "community.rs"),
        ).toMatch(/pub const MAX_ACTIVITIES: usize = 30;/);
        expect(read("src", "lib", "platform-devices.ts")).toMatch(
          /const MAX_ACTIVITIES = 30;/,
        );
        expect(MAX_SYNCED_ACTIVITIES).toBe(30);
      });

      it("keeps the person's own activities first and takes the oldest remote ones up to the cap", () => {
        const mine = known.slice(0, 10);
        const remote = known.slice(10, 50); // 40 more, oldest first
        const patch = patchFromDocs(
          [...mine, ...remote].map((id, i) => act(id, T0 + i * 1000)),
          state({ selectedActivities: mine }),
        );
        expect(patch.selectedActivities).toHaveLength(MAX_SYNCED_ACTIVITIES);
        expect(patch.selectedActivities?.slice(0, 10)).toEqual(mine);
        expect(patch.selectedActivities?.slice(10)).toEqual(
          remote.slice(0, 20),
        );
      });

      it("ties at an equal creation time are taken by id, so the result is the same on every device", () => {
        const ids = known.slice(0, 40);
        const a = patchFromDocs(
          ids.map((id) => act(id, T0)),
          state(),
        );
        const b = patchFromDocs(
          [...ids].reverse().map((id) => act(id, T0)),
          state(),
        );
        expect(a.selectedActivities).toHaveLength(MAX_SYNCED_ACTIVITIES);
        expect(a.selectedActivities).toEqual(b.selectedActivities);
        expect(a.selectedActivities).toEqual(
          [...ids].sort().slice(0, MAX_SYNCED_ACTIVITIES),
        );
      });

      it("a device already at the cap takes nothing more, and one over it loses nothing", () => {
        const full = known.slice(0, MAX_SYNCED_ACTIVITIES);
        expect(
          patchFromDocs(
            [...full, known[40]].map((id) => act(id)),
            state({ selectedActivities: full }),
          ),
        ).toEqual({});
        const over = known.slice(0, MAX_SYNCED_ACTIVITIES + 5);
        expect(
          patchFromDocs(
            over.map((id) => act(id)),
            state({ selectedActivities: over }),
          ),
        ).toEqual({});
      });
    });
  });

  it("activities come from the documents, oldest first", () => {
    const patch = patchFromDocs(
      [act("beekeeping", T0 + 2000), act("aquaculture", T0 + 1000)],
      state(),
    );
    expect(patch.selectedActivities).toEqual(["aquaculture", "beekeeping"]);
  });

  it("the order of new activities is by when they were made, as instants (other clients write other RFC 3339 forms)", () => {
    const made = (id: string, createdAt: string) => ({ ...act(id), createdAt });
    const patch = patchFromDocs(
      [
        made("planting", "2026-11-03T12:00:00+02:00"), // 10:00:00Z
        made("harvest", "2026-11-03T10:00:00.500Z"),
        made("mining", "2026-11-03T10:00:00Z"), // the same instant: by id
        made("weddings", "not a time"), // unreadable: last
        made("aquaculture", "2026-11-03T09:59:59.999999Z"),
      ],
      state(),
    );
    expect(patch.selectedActivities).toEqual([
      "aquaculture",
      "mining",
      "planting",
      "harvest",
      "weddings",
    ]);
  });

  // A missing document is not a removal. An activity is dropped from the
  // device only when the local database holds its TOMBSTONE (another device
  // deleted it and the deletion was pulled). No document at all means this
  // device has not seen it yet: a follower tab whose leader has not seeded, a
  // first cycle, a pull that has not landed, a local database that was just
  // created. Dropping on absence would erase a person's activities.
  it("an activity another device removed (its tombstone is here) disappears; one with no document at all, and one this client cannot sync, stay", () => {
    const patch = patchFromDocs(
      [],
      state({
        selectedActivities: ["livestock", "gardening", "Legacy_Id"],
      }),
      new Set(["activity:livestock"]),
    );
    expect(patch.selectedActivities).toEqual(["gardening", "Legacy_Id"]);
  });

  it("with no documents and no tombstones nothing is removed, whatever the device holds", () => {
    expect(
      patchFromDocs(
        [],
        state({ selectedActivities: ["livestock", "gardening", "Legacy_Id"] }),
      ),
    ).toEqual({});
    expect(
      patchFromDocs(
        [theme("dark")],
        state({ selectedActivities: ["livestock"] }),
      ),
    ).toEqual({ theme: "dark" });
  });

  it("a tombstone for an id the device does not hold, or one that is live again, removes nothing", () => {
    expect(
      patchFromDocs(
        [act("livestock")],
        state({ selectedActivities: ["livestock"] }),
        new Set(["activity:livestock", "activity:gardening"]),
      ),
    ).toEqual({});
  });

  it("a different order of the same activities is not a change", () => {
    expect(
      patchFromDocs(
        [act("aquaculture", T0 + 1000), act("beekeeping", T0 + 2000)],
        state({ selectedActivities: ["beekeeping", "aquaculture"] }),
      ),
    ).toEqual({});
  });

  describe("the person's own order is kept (the AI keeps only the first three)", () => {
    const ids = [
      "livestock",
      "gardening",
      "crop-farming",
      "football",
      "barbecue",
    ];
    // The documents were created in a different order than the person chose here.
    const docsFor = (list: string[]) =>
      list.map((id, i) => act(id, T0 + (list.length - i) * 1000));

    it("a remote add is appended after the activities the device already holds", () => {
      const current = ["livestock", "gardening", "crop-farming"];
      const patch = patchFromDocs(
        docsFor([...current, "football"]),
        state({ selectedActivities: current }),
      );
      expect(patch.selectedActivities).toEqual([...current, "football"]);
    });

    it("a remote remove drops that id and leaves the others in place", () => {
      const patch = patchFromDocs(
        docsFor(["livestock", "crop-farming", "football"]),
        state({ selectedActivities: ids.slice(0, 4) }),
        new Set(["activity:gardening"]),
      );
      expect(patch.selectedActivities).toEqual([
        "livestock",
        "crop-farming",
        "football",
      ]);
    });

    it("an add and a remove together keep the local order of what stays", () => {
      const patch = patchFromDocs(
        docsFor(["crop-farming", "livestock", "barbecue"]),
        state({
          selectedActivities: ["livestock", "gardening", "crop-farming"],
        }),
        new Set(["activity:gardening"]),
      );
      expect(patch.selectedActivities).toEqual([
        "livestock",
        "crop-farming",
        "barbecue",
      ]);
    });

    it("ids the device does not hold come in oldest first, and ties by id", () => {
      const patch = patchFromDocs(
        [
          act("weddings", T0 + 1000),
          act("aquaculture", T0 + 1000),
          act("mining", T0 + 1000),
          act("planting", T0),
        ],
        state({ selectedActivities: ["livestock"] }),
        new Set(["activity:livestock"]),
      );
      // "livestock" is a tombstone here: another device removed it.
      expect(patch.selectedActivities).toEqual([
        "planting",
        "aquaculture",
        "mining",
        "weddings",
      ]);
    });

    it("new ids go after the local ones and unsyncable ids keep their place", () => {
      const patch = patchFromDocs(
        docsFor(["livestock", "football"]),
        state({
          selectedActivities: ["Legacy_Id", "livestock", "Other_Legacy"],
        }),
      );
      expect(patch.selectedActivities).toEqual([
        "Legacy_Id",
        "livestock",
        "Other_Legacy",
        "football",
      ]);
    });

    it("a fresh device takes the order the documents were made in", () => {
      const patch = patchFromDocs(
        [act("beekeeping", T0 + 2000), act("aquaculture", T0 + 1000)],
        state(),
      );
      expect(patch.selectedActivities).toEqual(["aquaculture", "beekeeping"]);
    });

    it("the same members in any order is never a patch", () => {
      for (const order of [
        ids,
        [...ids].reverse(),
        [ids[2], ids[0], ...ids.slice(3), ids[1]],
      ]) {
        expect(
          patchFromDocs(docsFor(ids), state({ selectedActivities: order })),
        ).toEqual({});
      }
    });
  });

  it("documents of other ids are ignored", () => {
    expect(
      patchFromDocs(
        [doc({ id: "preference:homePlace" }), doc({ id: "savedPlace:x" })],
        state({ selectedActivities: ["livestock"] }),
        new Set(["activity:livestock"]),
      ).selectedActivities,
    ).toEqual([]);
    // They say nothing about activities: without a tombstone nothing changes.
    expect(
      patchFromDocs(
        [doc({ id: "preference:homePlace" }), doc({ id: "savedPlace:x" })],
        state({ selectedActivities: ["livestock"] }),
      ),
    ).toEqual({});
  });
});

describe("conflict rule (couchdb-documents.md)", () => {
  const at = (ms: number, extra: object = {}) => ({
    id: "preference:theme",
    updatedAt: toRfc3339(ms),
    ...extra,
  });

  it("the later updatedAt wins", () => {
    const master = at(T0);
    const fork = at(T0 + 1);
    expect(resolveUserDocConflict(master, fork)).toBe(fork);
    expect(resolveUserDocConflict(fork, master)).toBe(fork);
  });

  it("on an equal updatedAt the server's revision stays", () => {
    const master = at(T0, { who: "master" });
    const fork = at(T0, { who: "fork" });
    expect(resolveUserDocConflict(master, fork)).toBe(master);
  });

  // A tombstone carries updatedAt like any other revision (the validator makes
  // it carry the common fields), so a delete wins only by being later.
  describe("a delete is ordered like any other revision", () => {
    const remove = (ms: number) => at(ms, { _deleted: true as const });

    it("a delete on the server older than an edit made here loses to it: a re-add after a remote delete wins", () => {
      const master = remove(T0);
      const fork = at(T0 + 99_000);
      expect(resolveUserDocConflict(master, fork)).toBe(fork);
    });

    it("a delete on the server newer than the edit made here wins", () => {
      const master = remove(T0 + 99_000);
      const fork = at(T0);
      expect(resolveUserDocConflict(master, fork)).toBe(master);
    });

    it("a delete made here newer than the server's revision wins, an older one loses", () => {
      const master = at(T0);
      const newerDelete = remove(T0 + 5);
      const olderDelete = remove(T0 - 5);
      expect(resolveUserDocConflict(master, newerDelete)).toBe(newerDelete);
      expect(resolveUserDocConflict(master, olderDelete)).toBe(master);
    });

    it("two deletes at the same time: the server's stays", () => {
      const master = remove(T0);
      const fork = remove(T0);
      expect(resolveUserDocConflict(master, fork)).toBe(master);
    });

    it("an edit and a delete at the same time: the server's revision stays, whichever it is", () => {
      const edit = at(T0);
      const del = remove(T0);
      expect(resolveUserDocConflict(del, edit)).toBe(del);
      expect(resolveUserDocConflict(edit, del)).toBe(edit);
    });

    it("a server tombstone with no readable time (nothing the validator would accept) leaves the server's revision", () => {
      const master = { id: "activity:x", _deleted: true as const };
      const fork = { id: "activity:x", updatedAt: toRfc3339(T0 + 99_000) };
      expect(resolveUserDocConflict(master, fork as never)).toBe(master);
    });
  });

  // The pinned validator accepts times in exactly one form for what a client
  // WRITES, but another client's older revision, or a document written under an
  // earlier rule, may use any RFC 3339 form. Compared as text these order wrongly
  // ("00.500Z" sorts before "00Z", "12:00:00+02:00" after "10:30:00Z"), so
  // instants are compared as instants.
  describe("times are compared as instants, not as text", () => {
    const doc = (updatedAt: unknown, who: string) =>
      ({ id: "preference:theme", updatedAt, who }) as never;

    it.each([
      // [master, fork, who wins]
      ["2026-11-03T10:00:00Z", "2026-11-03T10:00:00.500Z", "fork"],
      ["2026-11-03T10:00:00.500Z", "2026-11-03T10:00:00Z", "master"],
      ["2026-11-03T10:00:00.5Z", "2026-11-03T10:00:00.500Z", "master"], // equal
      ["2026-11-03T10:00:00.250Z", "2026-11-03T10:00:00.5Z", "fork"],
      // 12:00+02:00 is 10:00Z: earlier than 10:30Z although it sorts after it.
      ["2026-11-03T12:00:00+02:00", "2026-11-03T10:30:00Z", "fork"],
      ["2026-11-03T10:30:00Z", "2026-11-03T12:00:00+02:00", "master"],
      // The same instant in two forms is a tie: the server's stays.
      ["2026-11-03T12:00:00+02:00", "2026-11-03T10:00:00Z", "master"],
      ["2026-11-03T10:00:00Z", "2026-11-03T05:00:00-05:00", "master"],
      // More fractional digits than a millisecond are cut, not refused.
      ["2026-11-03T10:00:00.123456Z", "2026-11-03T10:00:00.124Z", "fork"],
    ])("master %s, fork %s: %s wins", (m, f, who) => {
      const master = doc(m, "master");
      const fork = doc(f, "fork");
      expect(resolveUserDocConflict(master, fork)).toBe(
        who === "fork" ? fork : master,
      );
    });

    it.each([
      ["not a time"],
      [""],
      ["2026-11-03"],
      ["2026-11-03 10:00:00Z"],
      ["2026-13-45T25:61:61Z"],
      [12345],
      [null],
      [undefined],
    ])(
      "an unparsable time (%j) on either side leaves the server's revision",
      (bad) => {
        const good = "2026-11-03T10:00:00Z";
        const a = doc(good, "master");
        const b = doc(bad, "fork");
        expect(resolveUserDocConflict(a, b)).toBe(a);
        // And when the server's is the unreadable one, it still stays.
        const c = doc(bad, "master");
        const d = doc(good, "fork");
        expect(resolveUserDocConflict(c, d)).toBe(c);
      },
    );

    it("a local delete is ordered by its instant too", () => {
      const master = doc("2026-11-03T12:00:00+02:00", "master");
      const later = {
        id: "preference:theme",
        updatedAt: "2026-11-03T10:30:00Z",
        who: "fork",
        _deleted: true,
      } as never;
      expect(resolveUserDocConflict(master, later)).toBe(later);
    });
  });
});

describe("ids of both kinds line up", () => {
  it("builders produce the owned pattern", () => {
    expect(isOwnedDocId(preferenceDocId("theme"))).toBe(true);
    expect(isOwnedDocId(activityDocId("crop-farming"))).toBe(true);
  });
});
