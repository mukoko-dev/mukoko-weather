/**
 * The storage module, against a stand-in for the `persons` collection. A merge
 * is one read and at most one guarded `updateOne` of the changed list(s), so
 * the stand-in only has to match a filter on three fields and apply a `$set`.
 * No database is touched.
 *
 * What the stand-in can show: the module's merge, caps, scoping, "one write per
 * sync", the version guard and its retry, and that nothing it cannot read is
 * lost. What it cannot show: how a real server evaluates the guard under real
 * concurrency (the interleaving here is staged by a hook between the read and
 * the write), BSON date equality at the server, what the live `identity.persons`
 * validator accepts, or the driver's date round trip. Those are checked once on
 * staging with a throwaway person before the switch is flipped.
 */
import { describe, it, expect, vi } from "vitest";
import { ACTIVITIES } from "./activities";
import {
  MAX_PERSON_ACTIVITIES,
  MAX_PERSON_SAVED_PLACES,
  MAX_STORED_SAVED_PLACES,
  TOMBSTONE_RETENTION_MS,
  type PersonPreferencesPatch,
} from "./person-preferences";
import {
  PreferencesConflictError,
  createIdentityPersonsStore,
  type PersonsCollectionLike,
} from "./person-preferences-store";
import {
  ACT,
  ACT2,
  T1,
  T2,
  T3,
  activity,
  envelopeFor,
  place,
  placeId,
  without,
} from "./person-preferences-fixtures";

vi.mock("./mongo", () => ({ identityDb: vi.fn() }));

type Doc = Record<string, unknown>;
const NOW = new Date("2026-11-04T12:00:00.000Z");
const ME = "user_me";

// --- a stand-in for one collection ------------------------------------------

const clone = <T>(v: T): T =>
  v instanceof Date
    ? (new Date(v.getTime()) as T)
    : Array.isArray(v)
      ? (v.map(clone) as T)
      : v && typeof v === "object"
        ? (Object.fromEntries(
            Object.entries(v as Doc).map(([k, x]) => [k, clone(x)]),
          ) as T)
        : v;

const sameValue = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date
    ? a.getTime() === b.getTime()
    : a === b;

/** The three kinds of condition the module uses. */
function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Doc;
      if ("$ne" in c) return doc[key] !== c.$ne;
      if ("$exists" in c) return key in doc === c.$exists;
      throw new Error(`unsupported condition ${JSON.stringify(c)}`);
    }
    return sameValue(doc[key], cond);
  });
}

class FakePersons implements PersonsCollectionLike {
  readonly writes: { filter: Doc; update: Doc }[] = [];
  reads = 0;
  /** Runs between a read and the write that follows it: another writer. */
  beforeWrite: ((doc: Doc) => void) | null = null;
  constructor(public doc: Doc | null) {}

  async findOne(filter: Doc, options?: { projection?: Doc }) {
    this.reads += 1;
    if (!this.doc || !matches(this.doc, filter)) return null;
    const out = clone(this.doc);
    const keep = Object.keys(options?.projection ?? {});
    return keep.length
      ? Object.fromEntries(
          Object.entries(out).filter(([k]) => keep.includes(k)),
        )
      : out;
  }

  async updateOne(filter: Doc, update: Doc) {
    this.writes.push({ filter: clone(filter), update: clone(update) });
    if (this.doc) this.beforeWrite?.(this.doc);
    if (!this.doc || !matches(this.doc, filter)) return { matchedCount: 0 };
    const keys = Object.keys(update);
    if (keys.length !== 1 || keys[0] !== "$set") {
      throw new Error(`unsupported update ${keys.join(",")}`);
    }
    for (const [k, v] of Object.entries(update.$set as Doc)) {
      this.doc[k] = clone(v);
    }
    return { matchedCount: 1 };
  }
}

const person = (extra: Doc = {}): Doc => ({
  _id: "p1",
  workosUserId: ME,
  isActive: true,
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...extra,
});

const patch = (
  over: Partial<PersonPreferencesPatch> = {},
): PersonPreferencesPatch => ({
  activities: [],
  savedPlaces: [],
  ...over,
});

const d = (iso: string) => new Date(iso);
const storedActivity = (
  id: string,
  at: string,
  tombstone = false,
  created = at,
) => ({
  activityId: id,
  createdAt: d(created),
  updatedAt: d(at),
  tombstone,
});

const storeOver = (col: FakePersons) => createIdentityPersonsStore(() => col);

// --- read -----------------------------------------------------------------------

describe("read", () => {
  it("is null when the person has no active record", async () => {
    expect(await storeOver(new FakePersons(null)).read(ME)).toBeNull();
    expect(
      await storeOver(new FakePersons(person({ isActive: false }))).read(ME),
    ).toBeNull();
    expect(
      await storeOver(new FakePersons(person())).read("user_other"),
    ).toBeNull();
  });

  it("is empty for a person with nothing stored", async () => {
    expect(await storeOver(new FakePersons(person())).read(ME)).toEqual({
      activities: [],
      savedPlaces: [],
    });
  });

  it("reads a null field as an empty list (the validator allows null)", async () => {
    const col = new FakePersons(
      person({ activities: null, savedPlaces: null }),
    );
    expect(await storeOver(col).read(ME)).toEqual({
      activities: [],
      savedPlaces: [],
    });
  });

  it("turns stored dates into the wire form and skips entries it did not write", async () => {
    const col = new FakePersons(
      person({
        activities: [
          storedActivity(ACT, T1),
          {
            activityId: "Bad Id",
            createdAt: d(T1),
            updatedAt: d(T1),
            tombstone: false,
          },
          {
            activityId: ACT2,
            createdAt: "2026-11-04",
            updatedAt: d(T1),
            tombstone: false,
          },
          { activityId: ACT2, createdAt: d(T1), updatedAt: d(T1) },
          "junk",
          null,
        ],
        savedPlaces: [
          {
            savedPlaceId: placeId(1),
            createdAt: d(T1),
            updatedAt: d(T1),
            tombstone: false,
            envelope: { protected: "x" },
          },
          {
            savedPlaceId: placeId(2),
            createdAt: d(T1),
            updatedAt: d(T2),
            tombstone: true,
          },
        ],
      }),
    );
    const read = await storeOver(col).read(ME);
    expect(read?.activities).toEqual([activity({ activityId: ACT })]);
    expect(read?.savedPlaces).toEqual([
      without(
        place({ savedPlaceId: placeId(2), updatedAt: T2, tombstone: true }),
        "envelope",
      ),
    ]);
  });

  it("reads only the two fields and the version", async () => {
    const col = new FakePersons(person({ email: "a@example.com" }));
    const spy = vi.spyOn(col, "findOne");
    await storeOver(col).read(ME);
    expect(spy.mock.calls[0][1]).toEqual({
      projection: { activities: 1, savedPlaces: 1, updatedAt: 1 },
    });
  });
});

// --- merging activities --------------------------------------------------------------

describe("merge: activities", () => {
  it("is no_person, and writes nothing, without an active record", async () => {
    const col = new FakePersons(null);
    const r = await storeOver(col).merge(
      ME,
      patch({ activities: [activity()] }),
      NOW,
    );
    expect(r).toEqual({ kind: "no_person" });
    expect(col.writes).toHaveLength(0);
  });

  it("adds items to an empty person", async () => {
    const col = new FakePersons(person());
    const r = await storeOver(col).merge(
      ME,
      patch({
        activities: [
          activity({ activityId: ACT }),
          activity({ activityId: ACT2, createdAt: T2, updatedAt: T2 }),
        ],
      }),
      NOW,
    );
    expect(
      r.kind === "ok" && r.stored.activities.map((a) => a.activityId),
    ).toEqual([ACT, ACT2]);
    expect(await storeOver(col).read(ME)).toMatchObject({
      activities: [{ activityId: ACT }, { activityId: ACT2 }],
    });
  });

  it("takes a later write, keeps the first createdAt, ignores an earlier one and a tie", async () => {
    const col = new FakePersons(
      person({ activities: [storedActivity(ACT, T2, false, T1)] }),
    );
    const store = storeOver(col);

    await store.merge(
      ME,
      patch({
        activities: [
          activity({ createdAt: T3, updatedAt: T3, tombstone: true }),
        ],
      }),
      NOW,
    );
    expect(await store.read(ME)).toMatchObject({
      activities: [{ createdAt: T1, updatedAt: T3, tombstone: true }],
    });

    await store.merge(
      ME,
      patch({ activities: [activity({ updatedAt: T1, tombstone: false })] }),
      NOW,
    );
    expect(await store.read(ME)).toMatchObject({
      activities: [{ updatedAt: T3, tombstone: true }],
    });

    await store.merge(
      ME,
      patch({ activities: [activity({ updatedAt: T3, tombstone: false })] }),
      NOW,
    );
    expect(await store.read(ME)).toMatchObject({
      activities: [{ updatedAt: T3, tombstone: true }],
    });
  });

  it("revives a tombstone with a later live write", async () => {
    const col = new FakePersons(
      person({ activities: [storedActivity(ACT, T2, true, T1)] }),
    );
    const store = storeOver(col);
    await store.merge(
      ME,
      patch({ activities: [activity({ updatedAt: T3 })] }),
      NOW,
    );
    expect(await store.read(ME)).toMatchObject({
      activities: [{ tombstone: false, updatedAt: T3 }],
    });
  });

  it("two devices in either order give the same lists (union, later removal wins)", async () => {
    const deviceA = patch({
      activities: [
        activity({ activityId: ACT, updatedAt: T1 }),
        activity({ activityId: ACT2, updatedAt: T1 }),
      ],
    });
    const deviceB = patch({
      activities: [
        activity({ activityId: ACT, updatedAt: T2, tombstone: true }),
        activity({
          activityId: ACTIVITIES[2].id,
          createdAt: T2,
          updatedAt: T2,
        }),
      ],
    });
    const run = async (
      first: PersonPreferencesPatch,
      second: PersonPreferencesPatch,
    ) => {
      const col = new FakePersons(person());
      const store = storeOver(col);
      await store.merge(ME, first, NOW);
      await store.merge(ME, second, NOW);
      // Storage order is arrival order; the response sorts (toDocument).
      return (await store.read(ME))?.activities.sort((a, b) =>
        a.activityId < b.activityId ? -1 : 1,
      );
    };
    const ab = await run(deviceA, deviceB);
    const ba = await run(deviceB, deviceA);
    expect(ab).toEqual(ba);
    expect(ab?.map((a) => [a.activityId, a.tombstone])).toEqual(
      expect.arrayContaining([
        [ACT, true],
        [ACT2, false],
        [ACTIVITIES[2].id, false],
      ]),
    );
  });

  it("refuses an activity over the cap and applies nothing", async () => {
    const col = new FakePersons(
      person({
        activities: ACTIVITIES.slice(0, MAX_PERSON_ACTIVITIES).map((a) =>
          storedActivity(a.id, T1),
        ),
      }),
    );
    const r = await storeOver(col).merge(
      ME,
      patch({
        activities: [
          activity({ activityId: ACTIVITIES[MAX_PERSON_ACTIVITIES].id }),
          activity({
            activityId: ACTIVITIES[0].id,
            updatedAt: T2,
            tombstone: true,
          }),
          activity({ activityId: ACTIVITIES[MAX_PERSON_ACTIVITIES + 1].id }),
        ],
      }),
      NOW,
    );
    // The cap live, minus one removed, plus two added: one over.
    expect(r).toEqual({
      kind: "refused",
      problem: { status: 422, code: "too_many_activities" },
    });
    expect(col.writes).toHaveLength(0);
    expect((col.doc?.activities as unknown[]).length).toBe(
      MAX_PERSON_ACTIVITIES,
    );
  });

  it("lets a person at the cap swap one for another", async () => {
    const col = new FakePersons(
      person({
        activities: ACTIVITIES.slice(0, MAX_PERSON_ACTIVITIES).map((a) =>
          storedActivity(a.id, T1),
        ),
      }),
    );
    const r = await storeOver(col).merge(
      ME,
      patch({
        activities: [
          activity({
            activityId: ACTIVITIES[0].id,
            updatedAt: T2,
            tombstone: true,
          }),
          activity({
            activityId: ACTIVITIES[MAX_PERSON_ACTIVITIES].id,
            createdAt: T2,
            updatedAt: T2,
          }),
        ],
      }),
      NOW,
    );
    expect(r.kind).toBe("ok");
  });

  it("drops tombstones older than 30 days on a write, keeps recent ones and live items", async () => {
    const old = new Date(
      NOW.getTime() - TOMBSTONE_RETENTION_MS - 60_000,
    ).toISOString();
    const fresh = new Date(
      NOW.getTime() - TOMBSTONE_RETENTION_MS + 3_600_000,
    ).toISOString();
    const col = new FakePersons(
      person({
        activities: [
          storedActivity("old-gone", old, true),
          storedActivity("fresh-gone", fresh, true),
          storedActivity(ACT, old, false),
        ],
      }),
    );
    const store = storeOver(col);
    await store.merge(
      ME,
      patch({ activities: [activity({ activityId: ACT2 })] }),
      NOW,
    );
    const ids = (await store.read(ME))?.activities.map((a) => a.activityId);
    expect(ids).toEqual(expect.arrayContaining([ACT, ACT2, "fresh-gone"]));
    expect(ids).not.toContain("old-gone");
  });
});

// --- one write per sync ----------------------------------------------------------------

describe("one write per sync", () => {
  const many = patch({
    activities: ACTIVITIES.slice(0, 8).map((a, i) =>
      activity({ activityId: a.id, createdAt: T1, updatedAt: i % 2 ? T2 : T1 }),
    ),
    savedPlaces: [
      place(),
      place({ savedPlaceId: placeId(2), envelope: envelopeFor(placeId(2)) }),
    ],
  });

  it("writes once, however many items, and moves updatedAt once", async () => {
    const col = new FakePersons(person());
    await storeOver(col).merge(ME, many, NOW);
    expect(col.writes).toHaveLength(1);
    expect(col.doc?.updatedAt).toEqual(NOW);
    expect(col.reads).toBe(1);
  });

  it("writes only the lists that changed", async () => {
    const col = new FakePersons(person());
    await storeOver(col).merge(ME, patch({ activities: [activity()] }), NOW);
    const set = col.writes[0].update.$set as Doc;
    expect(Object.keys(set).sort()).toEqual(["activities", "updatedAt"]);
    expect(col.doc).not.toHaveProperty("savedPlaces");
  });

  it("writes nothing, and leaves updatedAt alone, for a request that changes nothing", async () => {
    const col = new FakePersons(person());
    const store = storeOver(col);
    await store.merge(ME, many, NOW);
    const at = (col.doc?.updatedAt as Date).getTime();
    const later = new Date(NOW.getTime() + 60_000);
    const again = await store.merge(ME, many, later);
    expect(again.kind).toBe("ok");
    expect(col.writes).toHaveLength(1);
    expect((col.doc?.updatedAt as Date).getTime()).toBe(at);
  });

  it("writes nothing for an empty request, and for one whose items all lose", async () => {
    const col = new FakePersons(
      person({ activities: [storedActivity(ACT, T3)] }),
    );
    const store = storeOver(col);
    const empty = await store.merge(ME, patch(), NOW);
    expect(empty.kind === "ok" && empty.stored.activities).toHaveLength(1);
    await store.merge(
      ME,
      patch({ activities: [activity({ updatedAt: T1 })] }),
      NOW,
    );
    expect(col.writes).toHaveLength(0);
  });

  it("moves updatedAt forward even when the server's clock is behind the record", async () => {
    const future = new Date(NOW.getTime() + 5_000);
    const col = new FakePersons(person({ updatedAt: future }));
    await storeOver(col).merge(ME, patch({ activities: [activity()] }), NOW);
    expect((col.doc?.updatedAt as Date).getTime()).toBe(future.getTime() + 1);
  });

  it("asks for the purge only as part of a write that was going to happen", async () => {
    const old = new Date(
      NOW.getTime() - TOMBSTONE_RETENTION_MS - 60_000,
    ).toISOString();
    const col = new FakePersons(
      person({ activities: [storedActivity("old-gone", old, true)] }),
    );
    await storeOver(col).merge(ME, patch(), NOW);
    expect(col.writes).toHaveLength(0);
    await storeOver(col).merge(ME, patch({ activities: [activity()] }), NOW);
    expect(col.writes).toHaveLength(1);
  });
});

// --- null, absent and things this code cannot read --------------------------------------------

describe("a field that is null, absent or holds entries this code did not write", () => {
  it("merges into a null list instead of failing (the validator allows null)", async () => {
    const col = new FakePersons(
      person({ activities: null, savedPlaces: null }),
    );
    const r = await storeOver(col).merge(
      ME,
      patch({ activities: [activity()], savedPlaces: [place()] }),
      NOW,
    );
    expect(r.kind).toBe("ok");
    expect(Array.isArray(col.doc?.activities)).toBe(true);
    expect(Array.isArray(col.doc?.savedPlaces)).toBe(true);
    expect(await storeOver(col).read(ME)).toMatchObject({
      activities: [{ activityId: ACT }],
      savedPlaces: [{ savedPlaceId: place().savedPlaceId }],
    });
  });

  it("merges into an absent list, and a purge of a null list is not an error", async () => {
    const col = new FakePersons(person());
    const r = await storeOver(col).merge(
      ME,
      patch({ activities: [activity()] }),
      NOW,
    );
    expect(r.kind).toBe("ok");
    expect(col.doc).not.toHaveProperty("savedPlaces");
  });

  it("keeps entries it cannot read, and fields it does not know on ones it can", async () => {
    const foreign = { activityId: "from-a-newer-writer", surprise: { x: 1 } };
    const known = { ...storedActivity(ACT, T1), deviceId: "install-1" };
    const col = new FakePersons(
      person({ activities: [known, foreign, "junk"] }),
    );
    await storeOver(col).merge(
      ME,
      patch({
        activities: [
          activity({ activityId: ACT2 }),
          activity({ activityId: ACT, updatedAt: T2, tombstone: true }),
        ],
      }),
      NOW,
    );
    const stored = col.doc?.activities as Doc[];
    expect(stored).toContainEqual(foreign);
    expect(stored).toContain("junk");
    const updated = stored.find((e) => e.activityId === ACT);
    expect(updated).toMatchObject({ deviceId: "install-1", tombstone: true });
    expect(stored.find((e) => e.activityId === ACT2)).toBeDefined();
  });

  it("writes an entry it did not change exactly as it found it", async () => {
    const known = { ...storedActivity(ACT, T1), deviceId: "install-1" };
    const col = new FakePersons(person({ activities: [known] }));
    await storeOver(col).merge(
      ME,
      patch({ activities: [activity({ activityId: ACT2 })] }),
      NOW,
    );
    const stored = col.doc?.activities as Doc[];
    expect(stored.find((e) => e.activityId === ACT)).toEqual(known);
  });
});

// --- concurrent writers --------------------------------------------------------------------------

describe("when the record changes between the read and the write", () => {
  it("reads and merges again, once, and keeps the other writer's change", async () => {
    const col = new FakePersons(person());
    let interleaved = false;
    col.beforeWrite = (doc) => {
      if (interleaved) return;
      interleaved = true;
      // Another device writes first.
      doc.activities = [storedActivity(ACT2, T2)];
      doc.updatedAt = new Date(NOW.getTime() - 1_000);
    };
    const r = await storeOver(col).merge(
      ME,
      patch({ activities: [activity()] }),
      NOW,
    );
    expect(
      r.kind === "ok" && r.stored.activities.map((a) => a.activityId).sort(),
    ).toEqual([ACT, ACT2].sort());
    expect(col.writes).toHaveLength(2);
    expect(col.reads).toBe(2);
    expect(
      (col.doc?.activities as Doc[]).map((e) => e.activityId).sort(),
    ).toEqual([ACT, ACT2].sort());
  });

  it("judges the cap on what is written: two devices each adding the last slot cannot both succeed", async () => {
    const full = ACTIVITIES.slice(0, MAX_PERSON_ACTIVITIES - 1).map((a) =>
      storedActivity(a.id, T1),
    );
    const col = new FakePersons(person({ activities: full }));
    const slotA = ACTIVITIES[MAX_PERSON_ACTIVITIES].id;
    const slotB = ACTIVITIES[MAX_PERSON_ACTIVITIES + 1].id;
    col.beforeWrite = (doc) => {
      if (col.writes.length > 1) return;
      doc.activities = [
        ...(doc.activities as Doc[]),
        storedActivity(slotB, T2),
      ];
      doc.updatedAt = new Date(NOW.getTime() - 1_000);
    };
    const r = await storeOver(col).merge(
      ME,
      patch({
        activities: [
          activity({ activityId: slotA, createdAt: T3, updatedAt: T3 }),
        ],
      }),
      NOW,
    );
    expect(r).toEqual({
      kind: "refused",
      problem: { status: 422, code: "too_many_activities" },
    });
    expect((col.doc?.activities as Doc[]).length).toBe(MAX_PERSON_ACTIVITIES);
  });

  it("gives up with a conflict error, writing nothing of its own, if it keeps losing", async () => {
    const col = new FakePersons(person());
    let n = 0;
    col.beforeWrite = (doc) => {
      n += 1;
      doc.updatedAt = new Date(NOW.getTime() - 10_000 + n);
    };
    await expect(
      storeOver(col).merge(ME, patch({ activities: [activity()] }), NOW),
    ).rejects.toBeInstanceOf(PreferencesConflictError);
    expect(col.writes).toHaveLength(2);
    expect(col.doc).not.toHaveProperty("activities");
    expect(new PreferencesConflictError().name).toBe("PreferencesConflict");
  });

  it("guards the write on the updatedAt it read", async () => {
    const at = new Date("2026-02-02T00:00:00.000Z");
    const col = new FakePersons(person({ updatedAt: at }));
    await storeOver(col).merge(ME, patch({ activities: [activity()] }), NOW);
    expect(col.writes[0].filter.updatedAt).toEqual(at);
  });

  it("guards a record that has no updatedAt on its absence", async () => {
    const doc = person();
    delete doc.updatedAt;
    const col = new FakePersons(doc);
    const r = await storeOver(col).merge(
      ME,
      patch({ activities: [activity()] }),
      NOW,
    );
    expect(r.kind).toBe("ok");
    expect(col.writes[0].filter.updatedAt).toEqual({ $exists: false });
  });
});

// --- saved places (ciphertext) -------------------------------------------------------------------------

describe("merge: saved places (ciphertext)", () => {
  it("stores a place with its envelope and nothing readable", async () => {
    const col = new FakePersons(person());
    const r = await storeOver(col).merge(
      ME,
      patch({ savedPlaces: [place()] }),
      NOW,
    );
    expect(r.kind === "ok" && r.stored.savedPlaces).toEqual([place()]);
    const raw = JSON.stringify(col.doc?.savedPlaces);
    expect(raw).not.toMatch(/placeKey|"place"|"name"|nairobi/);
  });

  it("drops the envelope on a tombstone and restores it on a later revive", async () => {
    const col = new FakePersons(person());
    const store = storeOver(col);
    await store.merge(
      ME,
      patch({ savedPlaces: [place({ updatedAt: T1 })] }),
      NOW,
    );

    const gone = without(place({ updatedAt: T2, tombstone: true }), "envelope");
    await store.merge(ME, patch({ savedPlaces: [gone] }), NOW);
    const afterTomb = (col.doc?.savedPlaces as Doc[])[0];
    expect(afterTomb.tombstone).toBe(true);
    expect(afterTomb).not.toHaveProperty("envelope");

    await store.merge(
      ME,
      patch({ savedPlaces: [place({ updatedAt: T3 })] }),
      NOW,
    );
    expect(await store.read(ME)).toMatchObject({
      savedPlaces: [
        { tombstone: false, updatedAt: T3, envelope: envelopeFor() },
      ],
    });
  });

  it("refuses an 11th live place", async () => {
    const col = new FakePersons(person());
    const places = Array.from({ length: MAX_PERSON_SAVED_PLACES + 1 }, (_, n) =>
      place({ savedPlaceId: placeId(n), envelope: envelopeFor(placeId(n)) }),
    );
    const r = await storeOver(col).merge(
      ME,
      patch({ savedPlaces: places }),
      NOW,
    );
    expect(r).toEqual({
      kind: "refused",
      problem: { status: 422, code: "too_many_places" },
    });
    expect(col.writes).toHaveLength(0);
  });

  it("bounds tombstones too", async () => {
    const col = new FakePersons(person());
    const tombs = Array.from(
      { length: MAX_STORED_SAVED_PLACES + 1 },
      (_, n) => ({
        savedPlaceId: placeId(n),
        createdAt: T1,
        updatedAt: T1,
        tombstone: true,
      }),
    );
    const r = await storeOver(col).merge(
      ME,
      patch({ savedPlaces: tombs }),
      NOW,
    );
    expect(r).toMatchObject({
      kind: "refused",
      problem: { code: "too_many_places" },
    });
  });
});

// --- what every write is scoped to ----------------------------------------------------------------------------

describe("what every write is scoped to", () => {
  it("matches the verified person, and sets only the two lists and updatedAt", async () => {
    const col = new FakePersons(person());
    await storeOver(col).merge(
      ME,
      patch({ activities: [activity()], savedPlaces: [place()] }),
      NOW,
    );
    const { filter, update } = col.writes[0];
    expect(filter.workosUserId).toBe(ME);
    expect(filter.isActive).toEqual({ $ne: false });
    expect(Object.keys(update)).toEqual(["$set"]);
    expect(Object.keys(update.$set as Doc).sort()).toEqual([
      "activities",
      "savedPlaces",
      "updatedAt",
    ]);
  });

  it("never upserts and never replaces the record", async () => {
    const col = new FakePersons(person());
    await storeOver(col).merge(ME, patch({ activities: [activity()] }), NOW);
    const serialised = JSON.stringify(col.writes);
    expect(serialised).not.toContain("upsert");
    expect(serialised).not.toContain("replace");
    expect(serialised).not.toContain("$setOnInsert");
  });

  it("another person's record is never touched", async () => {
    const col = new FakePersons(person({ workosUserId: "user_other" }));
    const r = await storeOver(col).merge(
      ME,
      patch({ activities: [activity()] }),
      NOW,
    );
    expect(r.kind).toBe("no_person");
    expect(col.doc?.activities).toBeUndefined();
  });

  it("leaves the other fields of the record as they were", async () => {
    const col = new FakePersons(
      person({ email: "a@example.com", givenName: "Ada" }),
    );
    await storeOver(col).merge(ME, patch({ activities: [activity()] }), NOW);
    expect(col.doc).toMatchObject({
      email: "a@example.com",
      givenName: "Ada",
      workosUserId: ME,
    });
  });
});
