import { describe, expect, it } from "vitest";
import {
  ACTIVITY_ID_RE,
  COUCH_DOC_SCHEMA_VERSION,
  FORECAST_MODEL_VALUES,
  activityDocId,
  assertPlaintextDoc,
  isOwnedDocId,
  isWellFormedDoc,
  patchFromDocs,
  personIdFromDatabase,
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
import { FakeCouch } from "./test-support/couch-fake-server";

const PERSON = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const DEVICE = "11111111-2222-4333-8444-555555555555";
const T0 = Date.parse("2026-11-02T10:00:00.000Z");
const ctx = (nowMs = T0): DocContext => ({
  personId: PERSON,
  deviceId: DEVICE,
  nowMs,
});
const state = (over: Partial<SyncableState> = {}): SyncableState => ({
  theme: "system",
  selectedForecastModel: "best_match",
  selectedActivities: [],
  ...over,
});

/** The pinned CouchDB validator is the judge of every document we make. */
function validatorAccepts(doc: UserDocType): boolean {
  const couch = new FakeCouch({ personId: PERSON, token: "x" });
  const { id, ...rest } = doc;
  return couch.seed({ _id: id, ...rest }).ok;
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

  it("the forecast model list is exactly the data model's", () => {
    // data-infra user.preference.schema.json (staging), pinned.
    expect([...FORECAST_MODEL_VALUES]).toEqual([
      "best_match",
      "ecmwf_ifs",
      "ecmwf_aifs025_single",
      "gfs_seamless",
      "icon_global",
      "ukmo_global_deterministic_10km",
      "cma_grapes_global",
      "gem_global",
      "meteofrance_arpege_world",
      "jma_gsm",
    ]);
  });

  it("every activity id the app ships fits the data model's id pattern", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
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

  it("reads the person id from a personal database name only", () => {
    expect(personIdFromDatabase(`user_${PERSON}`)).toBe(PERSON);
    for (const bad of [
      "family_x",
      "user_",
      "user_UPPER",
      "user_a/b",
      "_users",
      "",
      null,
      7,
    ]) {
      expect(personIdFromDatabase(bad), String(bad)).toBeNull();
    }
  });
});

describe("documents are accepted by the validator CouchDB runs", () => {
  it("a theme change", () => {
    const [doc] = upserts(
      planChangeOps(state(), state({ theme: "dark" }), new Map(), ctx()),
    );
    expect(doc).toMatchObject({
      id: "preference:theme",
      type: "preference",
      preferenceKey: "theme",
      preferenceValue: "dark",
      schemaVersion: COUCH_DOC_SCHEMA_VERSION,
      ownerPersonId: PERSON,
      deviceId: DEVICE,
      createdAt: "2026-11-02T10:00:00.000Z",
      updatedAt: "2026-11-02T10:00:00.000Z",
    });
    expect(isWellFormedDoc(doc)).toBe(true);
    expect(validatorAccepts(doc)).toBe(true);
  });

  it("a forecast model change and an activity", () => {
    const docs = upserts(
      planChangeOps(
        state(),
        state({
          selectedForecastModel: "ecmwf_ifs",
          selectedActivities: ["crop-farming"],
        }),
        new Map(),
        ctx(),
      ),
    );
    expect(docs.map((d) => d.id).sort()).toEqual([
      "activity:crop-farming",
      "preference:forecastModel",
    ]);
    for (const d of docs) {
      expect(isWellFormedDoc(d)).toBe(true);
      expect(validatorAccepts(d)).toBe(true);
    }
  });

  it("the wire form of a document has no field outside the allow-list", () => {
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
        "ownerPersonId",
        "schemaVersion",
        "type",
        "updatedAt",
      ].sort(),
    );
  });

  it("a tombstone is the id and the deleted flag, which the validator accepts", () => {
    expect(tombstoneWire("activity:livestock")).toEqual({
      id: "activity:livestock",
      _deleted: true,
    });
    const couch = new FakeCouch({ personId: PERSON, token: "x" });
    expect(
      couch.seed({
        _id: "activity:livestock",
        type: "activity",
        schemaVersion: 1,
        ownerPersonId: PERSON,
        updatedAt: toRfc3339(T0),
      }).ok,
    ).toBe(true);
    const rev = couch.get("activity:livestock")?._rev;
    expect(
      couch.seed({ _id: "activity:livestock", _rev: rev, _deleted: true }).ok,
    ).toBe(true);
  });

  it("the validator refuses the data-infra tombstone and string schemaVersion (known contract delta)", () => {
    // Documents the mismatch the PR reports: data-infra's generated schema keeps
    // the common fields on a tombstone and writes schemaVersion as "v3.1".
    const couch = new FakeCouch({ personId: PERSON, token: "x" });
    couch.seed({
      _id: "activity:livestock",
      type: "activity",
      schemaVersion: 1,
      ownerPersonId: PERSON,
      updatedAt: toRfc3339(T0),
    });
    const rev = couch.get("activity:livestock")?._rev;
    const fat = couch.seed({
      _id: "activity:livestock",
      _rev: rev,
      _deleted: true,
      type: "activity",
      updatedAt: toRfc3339(T0),
    });
    expect(fat.ok).toBe(false);
    const stringVersion = couch.seed({
      _id: "activity:gardening",
      type: "activity",
      schemaVersion: "v3.1",
      ownerPersonId: PERSON,
      updatedAt: toRfc3339(T0),
    });
    expect(stringVersion.ok).toBe(false);
  });
});

describe("contract delta that blocks the encrypted types (next slice)", () => {
  it("the deployed validator refuses the camelCase types of the data model", () => {
    // gateway couch_validate_personal.js: type must match /^[a-z][a-z0-9_.-]{0,63}$/.
    // data-infra names four types in camelCase. Until one side moves, these
    // cannot be written to user_<personId>; the two this slice syncs, and
    // `interest`, are lower case and are accepted.
    const couch = new FakeCouch({ personId: PERSON, token: "x" });
    const write = (type: string) =>
      couch.seed({
        _id: `${type}:abc`,
        type,
        schemaVersion: 1,
        ownerPersonId: PERSON,
        updatedAt: toRfc3339(T0),
      }).ok;
    for (const refused of [
      "savedPlace",
      "engagementEvent",
      "historyEntry",
      "deviceNote",
    ]) {
      expect(write(refused), refused).toBe(false);
    }
    for (const accepted of ["activity", "preference", "interest"]) {
      expect(write(accepted), accepted).toBe(true);
    }
  });
});

describe("the plaintext gate", () => {
  const base: UserDocType = {
    id: "preference:theme",
    type: "preference",
    schemaVersion: 1,
    ownerPersonId: PERSON,
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

  it("refuses the locational setting, other types and bad values", () => {
    const refused: Partial<UserDocType>[] = [
      { id: "preference:homePlace", preferenceKey: "homePlace" as never },
      { id: "savedPlace:abc", type: "savedPlace" as never },
      { id: "interest:abc", type: "interest" as never },
      { id: "historyEntry:abc", type: "historyEntry" as never },
      { preferenceValue: "purple" },
      { id: "preference:language", preferenceKey: "language" as never },
    ];
    for (const over of refused) {
      expect(() => assertPlaintextDoc({ ...base, ...over })).toThrow(
        /couch-sync/,
      );
    }
  });

  it("the push modifier throws instead of sending a refused document", () => {
    expect(() =>
      toPushDoc({
        ...base,
        id: "preference:homePlace",
        preferenceKey: "homePlace" as never,
      }),
    ).toThrow();
    expect(toPushDoc({ ...base, _deleted: true })).toEqual({
      id: "preference:theme",
      _deleted: true,
    });
  });

  it("the pull modifier strips fields this client does not know", () => {
    const pulled = toPullDoc({
      ...base,
      _deleted: false,
      secret: "from another client",
    } as UserDocType & { _deleted: boolean });
    expect("secret" in pulled).toBe(false);
    expect(toPullDoc({ id: "activity:x", _deleted: true })).toEqual({
      id: "activity:x",
      _deleted: true,
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

  it("never writes a value the data model does not allow, or an unsyncable id", () => {
    const ops = planChangeOps(
      state(),
      state({
        theme: "purple",
        selectedForecastModel: "meteofrance_seamless",
        selectedActivities: ["Not_Valid", "has space"],
      }),
      new Map(),
      ctx(),
    );
    expect(ops).toEqual([]);
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
});

describe("documents -> state", () => {
  const doc = (over: Partial<UserDocType>): UserDocType => ({
    id: "preference:theme",
    type: "preference",
    schemaVersion: 1,
    ownerPersonId: PERSON,
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

  it("activities come from the documents, oldest first", () => {
    const patch = patchFromDocs(
      [act("b-second", T0 + 2000), act("a-first", T0 + 1000)],
      state(),
    );
    expect(patch.selectedActivities).toEqual(["a-first", "b-second"]);
  });

  it("an activity another device removed disappears; one this client cannot sync stays", () => {
    const patch = patchFromDocs(
      [],
      state({ selectedActivities: ["livestock", "Legacy_Id"] }),
    );
    expect(patch.selectedActivities).toEqual(["Legacy_Id"]);
  });

  it("a different order of the same activities is not a change", () => {
    expect(
      patchFromDocs(
        [act("a-first", T0 + 1000), act("b-second", T0 + 2000)],
        state({ selectedActivities: ["b-second", "a-first"] }),
      ),
    ).toEqual({});
  });

  describe("the person's own order is kept (the AI keeps only the first three)", () => {
    const ids = ["livestock", "gardening", "crop-farming", "soccer", "braai"];
    // The documents were created in a different order than the person chose here.
    const docsFor = (list: string[]) =>
      list.map((id, i) => act(id, T0 + (list.length - i) * 1000));

    it("a remote add is appended after the activities the device already holds", () => {
      const current = ["livestock", "gardening", "crop-farming"];
      const patch = patchFromDocs(
        docsFor([...current, "soccer"]),
        state({ selectedActivities: current }),
      );
      expect(patch.selectedActivities).toEqual([...current, "soccer"]);
    });

    it("a remote remove drops that id and leaves the others in place", () => {
      const patch = patchFromDocs(
        docsFor(["livestock", "crop-farming", "soccer"]),
        state({ selectedActivities: ids.slice(0, 4) }),
      );
      expect(patch.selectedActivities).toEqual([
        "livestock",
        "crop-farming",
        "soccer",
      ]);
    });

    it("an add and a remove together keep the local order of what stays", () => {
      const patch = patchFromDocs(
        docsFor(["crop-farming", "livestock", "braai"]),
        state({
          selectedActivities: ["livestock", "gardening", "crop-farming"],
        }),
      );
      expect(patch.selectedActivities).toEqual([
        "livestock",
        "crop-farming",
        "braai",
      ]);
    });

    it("ids the device does not hold come in oldest first, and ties by id", () => {
      const patch = patchFromDocs(
        [
          act("zulu", T0 + 1000),
          act("alpha", T0 + 1000),
          act("mike", T0 + 1000),
          act("early", T0),
        ],
        state({ selectedActivities: ["livestock"] }),
      );
      // "livestock" has no document: another device removed it.
      expect(patch.selectedActivities).toEqual([
        "early",
        "alpha",
        "mike",
        "zulu",
      ]);
    });

    it("new ids go after the local ones and unsyncable ids keep their place", () => {
      const patch = patchFromDocs(
        docsFor(["livestock", "soccer"]),
        state({
          selectedActivities: ["Legacy_Id", "livestock", "Other_Legacy"],
        }),
      );
      expect(patch.selectedActivities).toEqual([
        "Legacy_Id",
        "livestock",
        "Other_Legacy",
        "soccer",
      ]);
    });

    it("a fresh device takes the order the documents were made in", () => {
      const patch = patchFromDocs(
        [act("b-second", T0 + 2000), act("a-first", T0 + 1000)],
        state(),
      );
      expect(patch.selectedActivities).toEqual(["a-first", "b-second"]);
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
      ).selectedActivities,
    ).toEqual([]);
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

  it("a delete from the server carries no time and wins", () => {
    const master = { id: "activity:x", _deleted: true as const };
    const fork = { id: "activity:x", updatedAt: toRfc3339(T0 + 99_000) };
    expect(resolveUserDocConflict(master, fork as never)).toBe(master);
  });

  it("a local delete is ordered by its own time", () => {
    const master = at(T0);
    const newerDelete = at(T0 + 5, { _deleted: true });
    const olderDelete = at(T0 - 5, { _deleted: true });
    expect(resolveUserDocConflict(master, newerDelete)).toBe(newerDelete);
    expect(resolveUserDocConflict(master, olderDelete)).toBe(master);
  });
});

describe("ids of both kinds line up", () => {
  it("builders produce the owned pattern", () => {
    expect(isOwnedDocId(preferenceDocId("theme"))).toBe(true);
    expect(isOwnedDocId(activityDocId("crop-farming"))).toBe(true);
  });
});
