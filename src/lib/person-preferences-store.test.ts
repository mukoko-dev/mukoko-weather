/**
 * The storage module, against a stand-in for the `persons` collection that
 * understands exactly the operators the module uses ($push, $set, $unset,
 * $pull, $elemMatch, $ne, $lt, $expr/$size). No database is touched. The
 * stand-in encodes the documented MongoDB semantics of those operators, so
 * these tests prove the module's filters and updates add up to the pure merge
 * rules; the live behaviour is checked once, on staging, before the switch is
 * flipped (the PR says so).
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

const time = (v: unknown) => (v instanceof Date ? v.getTime() : NaN);
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

/** Values at a dotted path, looking through arrays. */
function valuesAt(doc: unknown, path: string): unknown[] {
  let cur: unknown[] = [doc];
  for (const part of path.split(".")) {
    cur = cur.flatMap((c) => {
      const next = (c as Doc | undefined)?.[part];
      return Array.isArray(next) ? next : next === undefined ? [] : [next];
    });
  }
  return cur;
}

function matchesCondition(value: unknown, cond: unknown): boolean {
  if (cond && typeof cond === "object" && !(cond instanceof Date)) {
    const c = cond as Doc;
    if ("$lt" in c) return time(value) < time(c.$lt);
    if ("$ne" in c) return value !== c.$ne;
    throw new Error(`unsupported condition ${JSON.stringify(c)}`);
  }
  return value === cond;
}

interface Match {
  ok: boolean;
  /** Index of the array element an `$elemMatch` matched, for `$`. */
  index: number | null;
}

function match(doc: Doc, filter: Doc): Match {
  let index: number | null = null;
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "$expr") {
      const [{ $size }, bound] = (
        cond as { $lt: [{ $size: { $ifNull: [string, unknown[]] } }, number] }
      ).$lt;
      const list = doc[$size.$ifNull[0].slice(1)];
      const size = Array.isArray(list) ? list.length : 0;
      if (!(size < bound)) return { ok: false, index };
      continue;
    }
    const c = cond as Doc;
    if (c && typeof c === "object" && "$elemMatch" in c) {
      const list = (doc[key] as Doc[] | undefined) ?? [];
      const found = list.findIndex((el) =>
        Object.entries(c.$elemMatch as Doc).every(([k, v]) =>
          matchesCondition(el[k], v),
        ),
      );
      if (found < 0) return { ok: false, index };
      index = found;
      continue;
    }
    if (key.includes(".") && c && typeof c === "object" && "$ne" in c) {
      // $ne on an array path: no element has the value.
      if (valuesAt(doc, key).includes(c.$ne)) return { ok: false, index };
      continue;
    }
    const values = key.includes(".") ? valuesAt(doc, key) : [doc[key]];
    if (!values.some((v) => matchesCondition(v, cond))) {
      return { ok: false, index };
    }
  }
  return { ok: true, index };
}

function applyUpdate(doc: Doc, update: Doc, index: number | null) {
  const target = (path: string): [Doc, string] => {
    const parts = path.split(".");
    if (parts.length === 3 && parts[1] === "$") {
      if (index === null) throw new Error("positional $ without a match");
      return [(doc[parts[0]] as Doc[])[index], parts[2]];
    }
    return [doc, path];
  };
  for (const [field, entry] of Object.entries((update.$push ?? {}) as Doc)) {
    ((doc[field] ??= []) as unknown[]).push(clone(entry));
  }
  for (const [path, value] of Object.entries((update.$set ?? {}) as Doc)) {
    const [obj, key] = target(path);
    obj[key] = clone(value);
  }
  for (const path of Object.keys((update.$unset ?? {}) as Doc)) {
    const [obj, key] = target(path);
    delete obj[key];
  }
  for (const [field, cond] of Object.entries((update.$pull ?? {}) as Doc)) {
    const list = doc[field];
    if (!Array.isArray(list)) continue;
    doc[field] = list.filter(
      (el) =>
        !Object.entries(cond as Doc).every(([k, v]) =>
          matchesCondition((el as Doc)[k], v),
        ),
    );
  }
}

class FakePersons implements PersonsCollectionLike {
  readonly writes: { filter: Doc; update: Doc }[][] = [];
  reads = 0;
  constructor(public doc: Doc | null) {}

  async findOne(filter: Doc, options?: { projection?: Doc }) {
    this.reads += 1;
    if (!this.doc || !match(this.doc, filter).ok) return null;
    const out = clone(this.doc);
    const keep = Object.keys(options?.projection ?? {});
    return keep.length
      ? Object.fromEntries(
          Object.entries(out).filter(([k]) => keep.includes(k)),
        )
      : out;
  }

  async bulkWrite(
    ops: { updateOne: { filter: Doc; update: Doc } }[],
    options: { ordered: boolean },
  ) {
    expect(options.ordered).toBe(true);
    this.writes.push(ops.map((o) => o.updateOne));
    for (const { updateOne } of ops) {
      if (!this.doc) continue;
      const m = match(this.doc, updateOne.filter);
      if (m.ok) applyUpdate(this.doc, updateOne.update, m.index);
    }
    return {};
  }
}

const person = (extra: Doc = {}): Doc => ({
  _id: "p1",
  workosUserId: ME,
  isActive: true,
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...extra,
});

const stored = (
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

function storeOver(col: FakePersons) {
  return createIdentityPersonsStore(() => col);
}

// --- tests --------------------------------------------------------------------

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
            envelope: { protected: "x" }, // not a valid envelope: dropped
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
      place({
        savedPlaceId: placeId(2),
        updatedAt: T2,
        tombstone: true,
        envelope: undefined,
      }),
    ]);
    expect(read?.savedPlaces[0]).not.toHaveProperty("envelope");
  });

  it("reads only the two fields", async () => {
    const col = new FakePersons(
      person({ email: "a@example.com", activities: [] }),
    );
    const spy = vi.spyOn(col, "findOne");
    await storeOver(col).read(ME);
    expect(spy.mock.calls[0][1]).toEqual({
      projection: { activities: 1, savedPlaces: 1 },
    });
  });
});

describe("merge: activities", () => {
  it("is no_person, and writes nothing, without an active record", async () => {
    const col = new FakePersons(null);
    const r = await storeOver(col).merge(
      ME,
      stored({ activities: [activity()] }),
      NOW,
    );
    expect(r).toEqual({ kind: "no_person" });
    expect(col.writes).toHaveLength(0);
  });

  it("adds items to an empty person and stamps the record's updatedAt", async () => {
    const col = new FakePersons(person());
    const r = await storeOver(col).merge(
      ME,
      stored({
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
    expect(col.doc?.updatedAt).toEqual(NOW);
  });

  it("takes a later write, keeps the first createdAt, ignores an earlier one and a tie", async () => {
    const col = new FakePersons(
      person({ activities: [storedActivity(ACT, T2, false, T1)] }),
    );
    const store = storeOver(col);

    await store.merge(
      ME,
      stored({
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
      stored({ activities: [activity({ updatedAt: T1, tombstone: false })] }),
      NOW,
    );
    expect(await store.read(ME)).toMatchObject({
      activities: [{ updatedAt: T3, tombstone: true }],
    });

    await store.merge(
      ME,
      stored({ activities: [activity({ updatedAt: T3, tombstone: false })] }),
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
      stored({ activities: [activity({ updatedAt: T3 })] }),
      NOW,
    );
    expect(await store.read(ME)).toMatchObject({
      activities: [{ tombstone: false, updatedAt: T3 }],
    });
  });

  it("two devices in either order give the same lists (union, later removal wins)", async () => {
    const deviceA = stored({
      activities: [
        activity({ activityId: ACT, updatedAt: T1 }),
        activity({ activityId: ACT2, updatedAt: T1 }),
      ],
    });
    const deviceB = stored({
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

  it("writes nothing for an empty request", async () => {
    const col = new FakePersons(
      person({ activities: [storedActivity(ACT, T1)] }),
    );
    const r = await storeOver(col).merge(ME, stored(), NOW);
    expect(r.kind === "ok" && r.stored.activities).toHaveLength(1);
    expect(col.writes).toHaveLength(0);
  });

  it("is idempotent", async () => {
    const col = new FakePersons(person());
    const store = storeOver(col);
    const patch = stored({ activities: [activity()] });
    await store.merge(ME, patch, NOW);
    const once = JSON.stringify(await store.read(ME));
    await store.merge(ME, patch, NOW);
    expect(JSON.stringify(await store.read(ME))).toBe(once);
  });

  it("refuses a 21st live activity and applies nothing", async () => {
    const col = new FakePersons(
      person({
        activities: ACTIVITIES.slice(0, MAX_PERSON_ACTIVITIES).map((a) =>
          storedActivity(a.id, T1),
        ),
      }),
    );
    const r = await storeOver(col).merge(
      ME,
      stored({
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
    // 20 live - 1 removed + 2 added = 21: over.
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
      stored({
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

  it("drops tombstones older than 30 days on the next write, keeps recent ones", async () => {
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
          storedActivity(ACT, old, false), // a live item is never purged by age
        ],
      }),
    );
    const store = storeOver(col);
    await store.merge(
      ME,
      stored({ activities: [activity({ activityId: ACT2 })] }),
      NOW,
    );
    const ids = (await store.read(ME))?.activities.map((a) => a.activityId);
    expect(ids).toEqual(expect.arrayContaining([ACT, ACT2]));
    expect(ids).toContain("fresh-gone");
    expect(ids).not.toContain("old-gone");
  });

  it("does not let a full list grow (the push is bounded in the database too)", async () => {
    const col = new FakePersons(
      person({
        activities: Array.from({ length: 100 }, (_, n) =>
          storedActivity(`a-${n}`, T1, true),
        ),
      }),
    );
    // Call the collection directly with a push, as a racing request would.
    await col.bulkWrite(
      [
        {
          updateOne: {
            filter: {
              workosUserId: ME,
              "activities.activityId": { $ne: ACT },
              $expr: {
                $lt: [{ $size: { $ifNull: ["$activities", []] } }, 100],
              },
            },
            update: { $push: { activities: storedActivity(ACT, T1) } },
          },
        },
      ],
      { ordered: true },
    );
    expect((col.doc?.activities as unknown[]).length).toBe(100);
  });
});

describe("merge: saved places (ciphertext)", () => {
  it("stores a place with its envelope and nothing readable", async () => {
    const col = new FakePersons(person());
    const r = await storeOver(col).merge(
      ME,
      stored({ savedPlaces: [place()] }),
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
      stored({ savedPlaces: [place({ updatedAt: T1 })] }),
      NOW,
    );

    const gone = without(place({ updatedAt: T2, tombstone: true }), "envelope");
    await store.merge(ME, stored({ savedPlaces: [gone] }), NOW);
    const afterTomb = (col.doc?.savedPlaces as Doc[])[0];
    expect(afterTomb.tombstone).toBe(true);
    expect(afterTomb).not.toHaveProperty("envelope");

    await store.merge(
      ME,
      stored({ savedPlaces: [place({ updatedAt: T3 })] }),
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
      place({
        savedPlaceId: placeId(n),
        envelope: envelopeFor(placeId(n)),
        createdAt: T1,
        updatedAt: T1,
      }),
    );
    const r = await storeOver(col).merge(
      ME,
      stored({ savedPlaces: places }),
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
      stored({ savedPlaces: tombs }),
      NOW,
    );
    expect(r).toMatchObject({
      kind: "refused",
      problem: { code: "too_many_places" },
    });
  });
});

describe("what every write is scoped to", () => {
  it("matches the verified person on every operation and touches only two fields", async () => {
    const col = new FakePersons(person());
    await storeOver(col).merge(
      ME,
      stored({ activities: [activity()], savedPlaces: [place()] }),
      NOW,
    );
    const ops = col.writes[0];
    expect(ops.length).toBeGreaterThan(1);
    for (const op of ops) {
      expect(op.filter.workosUserId).toBe(ME);
      expect(op.filter.isActive).toEqual({ $ne: false });
      const update = op.update as {
        $set?: Doc;
        $push?: Doc;
        $unset?: Doc;
        $pull?: Doc;
      };
      const touched = [
        ...Object.keys(update.$set ?? {}),
        ...Object.keys(update.$push ?? {}),
        ...Object.keys(update.$unset ?? {}),
        ...Object.keys(update.$pull ?? {}),
      ];
      for (const path of touched) {
        expect(path).toMatch(/^(activities|savedPlaces|updatedAt)(\.|$)/);
      }
      expect(
        Object.keys(update).every((k) =>
          ["$set", "$push", "$unset", "$pull"].includes(k),
        ),
      ).toBe(true);
    }
  });

  it("never upserts and never replaces the record", async () => {
    const col = new FakePersons(person());
    await storeOver(col).merge(ME, stored({ activities: [activity()] }), NOW);
    const serialised = JSON.stringify(col.writes);
    expect(serialised).not.toContain("upsert");
    expect(serialised).not.toContain("replace");
    expect(serialised).not.toContain("$setOnInsert");
  });

  it("another person's record is never touched", async () => {
    const col = new FakePersons(person({ workosUserId: "user_other" }));
    const r = await storeOver(col).merge(
      ME,
      stored({ activities: [activity()] }),
      NOW,
    );
    expect(r.kind).toBe("no_person");
    expect(col.doc?.activities).toBeUndefined();
  });

  it("leaves the other fields of the record as they were", async () => {
    const col = new FakePersons(
      person({ email: "a@example.com", givenName: "Ada" }),
    );
    await storeOver(col).merge(ME, stored({ activities: [activity()] }), NOW);
    expect(col.doc).toMatchObject({
      email: "a@example.com",
      givenName: "Ada",
      workosUserId: ME,
    });
  });
});
