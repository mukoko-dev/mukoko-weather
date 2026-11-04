/**
 * The person-preferences contract: what a request may carry, how two writes of
 * one item are ordered, and the caps. Pure; no storage, no network.
 */
import { describe, it, expect } from "vitest";
import { ACTIVITIES } from "./activities";
import {
  MAX_BODY_BYTES,
  MAX_CLOCK_AHEAD_MS,
  MAX_ENVELOPE_CIPHERTEXT,
  MAX_ITEMS_PER_REQUEST,
  MAX_PERSON_ACTIVITIES,
  MAX_PERSON_SAVED_PLACES,
  MAX_STORED_ACTIVITIES,
  MAX_STORED_SAVED_PLACES,
  PERSON_PREFERENCES_SCHEMA_VERSION,
  capProblem,
  mergeById,
  mergeItem,
  parseEnvelope,
  parsePatch,
  toDocument,
  activityIdOf,
  savedPlaceIdOf,
  type ActivityItem,
} from "./person-preferences";
import {
  ACT,
  ACT2,
  PLACE_ID,
  T1,
  T2,
  T3,
  activity,
  b64url,
  envelopeFor,
  place,
  placeId,
  without,
} from "./person-preferences-fixtures";
import {
  ACTIVITY_ID_RE as SHARED_ACTIVITY_ID_RE,
  MAX_SYNCED_ACTIVITIES,
  isWireTimestamp,
} from "./rxdb/couch-docs";
import { ACTIVITY_ID_RE } from "./person-preferences";
import { MAX_SAVED_LOCATIONS } from "./store";

const NOW = Date.parse("2026-11-04T12:00:00.000Z");

describe("constants", () => {
  it("takes the activity cap and the id pattern from the one shared definition", () => {
    expect(MAX_PERSON_ACTIVITIES).toBe(MAX_SYNCED_ACTIVITIES);
    expect(MAX_PERSON_ACTIVITIES).toBe(30);
    expect(ACTIVITY_ID_RE).toBe(SHARED_ACTIVITY_ID_RE);
  });
  it("caps live saved places at the number the app itself allows", () => {
    expect(MAX_PERSON_SAVED_PLACES).toBe(MAX_SAVED_LOCATIONS);
  });
  it("keeps stored bounds above the live caps", () => {
    expect(MAX_STORED_ACTIVITIES).toBeGreaterThan(MAX_PERSON_ACTIVITIES);
    expect(MAX_STORED_SAVED_PLACES).toBeGreaterThan(MAX_PERSON_SAVED_PLACES);
  });
  it("keeps a full set of saved places inside one request body", () => {
    const one = JSON.stringify(place({ envelope: envelopeFor() })).length;
    const ciphertext = MAX_ENVELOPE_CIPHERTEXT - 22;
    expect((one + ciphertext) * MAX_PERSON_SAVED_PLACES).toBeLessThan(
      MAX_BODY_BYTES,
    );
  });
});

describe("parsePatch: the body", () => {
  it("accepts an empty object and each list on its own", () => {
    expect(parsePatch({}, NOW)).toEqual({
      ok: true,
      patch: { activities: [], savedPlaces: [] },
      ignored: [],
    });
    const ok = parsePatch({ activities: [activity()] }, NOW);
    expect(ok.ok && ok.patch.activities).toEqual([activity()]);
  });

  it("accepts what GET returns, so a document can be sent back", () => {
    const doc = toDocument([activity()], [place()]);
    expect(parsePatch(doc, NOW).ok).toBe(true);
  });

  it("defaults tombstone to false", () => {
    const bare = without(activity(), "tombstone");
    const parsed = parsePatch({ activities: [bare] }, NOW);
    expect(parsed.ok && parsed.patch.activities[0].tombstone).toBe(false);
  });

  it.each([
    ["a string", "x"],
    ["an array", []],
    ["null", null],
    ["a number", 3],
  ])("refuses %s as the body with 400", (_n, body) => {
    expect(parsePatch(body, NOW)).toEqual({
      ok: false,
      problem: { status: 400, code: "invalid_body" },
    });
  });

  it("refuses an unknown top-level field, so a person id cannot ride along", () => {
    for (const field of ["userId", "personId", "workosUserId", "settingz"]) {
      expect(parsePatch({ [field]: "x" }, NOW)).toEqual({
        ok: false,
        problem: { status: 422, code: "unknown_field" },
      });
    }
  });

  it("refuses a schemaVersion it does not know", () => {
    expect(parsePatch({ schemaVersion: "v9.9" }, NOW)).toMatchObject({
      ok: false,
      problem: { code: "schema_version_not_supported" },
    });
    expect(
      parsePatch({ schemaVersion: PERSON_PREFERENCES_SCHEMA_VERSION }, NOW).ok,
    ).toBe(true);
  });

  it("takes empty settings and refuses real ones (not stored here)", () => {
    expect(parsePatch({ settings: {} }, NOW).ok).toBe(true);
    expect(
      parsePatch(
        { settings: { theme: { value: "dark", updatedAt: T1 } } },
        NOW,
      ),
    ).toMatchObject({ ok: false, problem: { code: "settings_not_supported" } });
  });

  it("refuses a malformed top-level updatedAt", () => {
    expect(parsePatch({ updatedAt: "yesterday" }, NOW).ok).toBe(false);
  });

  it("never carries a request value in a refusal", () => {
    const secret = "do-not-echo-me";
    const parsed = parsePatch({ activities: [{ activityId: secret }] }, NOW);
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain(secret);
  });
});

describe("parsePatch: activities", () => {
  it("refuses an id that is not in the app's catalogue", () => {
    expect(
      parsePatch({ activities: [activity({ activityId: "ghost" })] }, NOW),
    ).toMatchObject({ ok: false, problem: { code: "activity_not_allowed" } });
  });

  it.each(["Bad Id", "UPPER", "-lead", "a".repeat(65), ""])(
    "refuses the id %j by its form",
    (id) => {
      expect(
        parsePatch({ activities: [activity({ activityId: id })] }, NOW),
      ).toMatchObject({ ok: false, problem: { code: "invalid_activity" } });
    },
  );

  it("accepts every activity id the app ships", () => {
    const activities = ACTIVITIES.slice(0, MAX_ITEMS_PER_REQUEST).map((a) =>
      activity({ activityId: a.id }),
    );
    expect(parsePatch({ activities }, NOW).ok).toBe(true);
  });

  it("refuses a repeated id, a field it does not know, and a non-list", () => {
    expect(
      parsePatch({ activities: [activity(), activity()] }, NOW),
    ).toMatchObject({ problem: { code: "duplicate_item" } });
    expect(
      parsePatch({ activities: [{ ...activity(), extra: 1 }] }, NOW),
    ).toMatchObject({ problem: { code: "invalid_activity" } });
    expect(parsePatch({ activities: "x" }, NOW)).toMatchObject({
      problem: { code: "invalid_activity" },
    });
  });

  it("refuses too many items in one request", () => {
    const many = Array.from({ length: MAX_ITEMS_PER_REQUEST + 1 }, () =>
      activity(),
    );
    expect(parsePatch({ activities: many }, NOW)).toMatchObject({
      problem: { code: "too_many_activities" },
    });
  });

  it("checks the times", () => {
    for (const bad of [
      { createdAt: "2026-11-04" },
      { updatedAt: "2026-11-04T09:00:00Z" },
      { updatedAt: "2026-11-04T09:00:00.0Z" },
      { updatedAt: "2026-13-45T09:00:00.000Z" },
      // The pattern fits, but Date would roll these forward to 2 March, 1 May.
      { updatedAt: "2026-02-30T09:00:00.000Z" },
      { updatedAt: "2026-04-31T09:00:00.000Z" },
      { createdAt: "2026-02-30T09:00:00.000Z" },
      { createdAt: "2026-06-31T01:00:00.000Z", updatedAt: T1 },
      { createdAt: T3, updatedAt: T1 },
      { tombstone: "yes" },
    ]) {
      expect(parsePatch({ activities: [activity(bad as never)] }, NOW).ok).toBe(
        false,
      );
    }
  });

  it("refuses an updatedAt more than a day ahead, and takes one just inside", () => {
    const ahead = new Date(NOW + MAX_CLOCK_AHEAD_MS + 1_000).toISOString();
    const inside = new Date(NOW + MAX_CLOCK_AHEAD_MS - 1_000).toISOString();
    expect(
      parsePatch({ activities: [activity({ updatedAt: ahead })] }, NOW),
    ).toMatchObject({ problem: { status: 422, code: "updated_at_in_future" } });
    expect(
      parsePatch({ activities: [activity({ updatedAt: inside })] }, NOW).ok,
    ).toBe(true);
  });
});

describe("isWireTimestamp", () => {
  it("takes a real instant in the one wire form", () => {
    expect(isWireTimestamp(T1)).toBe(true);
    expect(isWireTimestamp("2024-02-29T23:59:59.999Z")).toBe(true); // a leap day
  });

  it.each([
    "2026-02-30T00:00:00.000Z",
    "2026-04-31T00:00:00.000Z",
    "2025-02-29T00:00:00.000Z", // not a leap year
    "2026-13-01T00:00:00.000Z",
    "2026-11-04T24:00:00.000Z",
    "2026-11-04T09:00:00Z",
    "2026-11-04T09:00:00.0000Z",
    "2026-11-04T09:00:00.000+02:00",
    "2026-11-04",
    "",
  ])("refuses %j", (v) => {
    expect(isWireTimestamp(v)).toBe(false);
  });

  it("refuses anything that is not a string", () => {
    for (const v of [null, undefined, 0, 1_762_000_000_000, {}, []]) {
      expect(isWireTimestamp(v)).toBe(false);
    }
  });

  it("is what a top-level updatedAt is held to", () => {
    expect(parsePatch({ updatedAt: "2026-02-30T00:00:00.000Z" }, NOW).ok).toBe(
      false,
    );
    expect(parsePatch({ updatedAt: T1 }, NOW).ok).toBe(true);
  });
});

describe("parsePatch: the savedPlaces option", () => {
  const bad = { savedPlaces: [{ place: "nairobi-ke" }, "junk"] };

  it("reads and validates saved places by default", () => {
    expect(parsePatch(bad, NOW).ok).toBe(false);
    const ok = parsePatch({ savedPlaces: [place()] }, NOW);
    expect(ok.ok && ok.ignored).toEqual([]);
    expect(ok.ok && ok.patch.savedPlaces).toEqual([place()]);
  });

  it("with the part turned off, ignores it unread and says so", () => {
    const parsed = parsePatch({ activities: [activity()], ...bad }, NOW, {
      savedPlaces: false,
    });
    expect(parsed).toEqual({
      ok: true,
      patch: { activities: [activity()], savedPlaces: [] },
      ignored: ["savedPlaces"],
    });
  });

  it("with the part turned off, says nothing when there was nothing to ignore", () => {
    for (const body of [
      {},
      { savedPlaces: [] },
      { activities: [activity()] },
    ]) {
      const parsed = parsePatch(body, NOW, { savedPlaces: false });
      expect(parsed.ok && parsed.ignored).toEqual([]);
    }
  });

  it("still holds the rest of the request to every rule", () => {
    expect(
      parsePatch({ activities: [{ activityId: "ghost" }], ...bad }, NOW, {
        savedPlaces: false,
      }).ok,
    ).toBe(false);
    expect(
      parsePatch({ savedPlaces: "nope" }, NOW, { savedPlaces: false }).ok,
    ).toBe(false);
  });
});

describe("parsePatch: saved places (ciphertext only)", () => {
  it("takes a live place with a well-formed envelope", () => {
    const parsed = parsePatch({ savedPlaces: [place()] }, NOW);
    expect(parsed.ok && parsed.patch.savedPlaces).toEqual([place()]);
  });

  it("takes a tombstone only without an envelope", () => {
    const bare = without(place({ tombstone: true }), "envelope");
    expect(parsePatch({ savedPlaces: [bare] }, NOW).ok).toBe(true);
    expect(
      parsePatch({ savedPlaces: [place({ tombstone: true })] }, NOW).ok,
    ).toBe(false);
  });

  it("refuses a live place with no envelope", () => {
    const bare = without(place(), "envelope");
    expect(parsePatch({ savedPlaces: [bare] }, NOW)).toMatchObject({
      problem: { code: "invalid_saved_place" },
    });
  });

  it("has no readable place field: a plaintext place is refused", () => {
    for (const field of ["place", "placeKey", "name", "slug", "position"]) {
      expect(
        parsePatch(
          { savedPlaces: [{ ...place(), [field]: "nairobi-ke" }] },
          NOW,
        ),
      ).toMatchObject({ ok: false, problem: { code: "invalid_saved_place" } });
    }
    expect(parsePatch({ savedPlaces: [{ place: "nairobi-ke" }] }, NOW).ok).toBe(
      false,
    );
  });

  it("wants a UUIDv7 for the place id, not a slug or a spot", () => {
    for (const id of [
      "nairobi-ke",
      "ksy4dd7--harare",
      "01934f6a-7b2c-4d3e-8a4f-5b6c7d8e9f01", // version 4
      "01934F6A-7B2C-7D3E-8A4F-5B6C7D8E9F01",
    ]) {
      expect(
        parsePatch({ savedPlaces: [place({ savedPlaceId: id })] }, NOW).ok,
      ).toBe(false);
    }
  });

  it("refuses a repeated place id and too many in one request", () => {
    expect(parsePatch({ savedPlaces: [place(), place()] }, NOW)).toMatchObject({
      problem: { code: "duplicate_item" },
    });
    const many = Array.from({ length: MAX_ITEMS_PER_REQUEST + 1 }, (_, n) =>
      place({ savedPlaceId: placeId(n), envelope: envelopeFor(placeId(n)) }),
    );
    expect(parsePatch({ savedPlaces: many }, NOW)).toMatchObject({
      problem: { code: "too_many_places" },
    });
  });
});

describe("parseEnvelope: the ADR-0002 JWE profile", () => {
  it("accepts the profile", () => {
    expect(parseEnvelope(envelopeFor(), PLACE_ID)).toEqual(envelopeFor());
  });

  it("refuses an aad that names another document (a ciphertext cannot be moved)", () => {
    const other = "01934f6a-7b2c-7d3e-8a4f-000000000002";
    expect(parseEnvelope(envelopeFor(other), PLACE_ID)).toBeNull();
  });

  it.each([
    ["zip", { zip: "DEF" }],
    ["jku", { jku: "https://evil.example/keys" }],
    ["jwk", { jwk: {} }],
    ["crit", { crit: ["b64"] }],
    ["alg none", { alg: "none" }],
    ["alg RSA-OAEP", { alg: "RSA-OAEP" }],
    ["enc A128GCM", { enc: "A128GCM" }],
    ["a kid with a slash", { kid: "a/b" }],
  ])("refuses a protected header with %s", (_n, header) => {
    expect(parseEnvelope(envelopeFor(PLACE_ID, header), PLACE_ID)).toBeNull();
  });

  it("refuses a missing kid, a non-JSON header and a non-base64url one", () => {
    const e = envelopeFor();
    expect(
      parseEnvelope(
        {
          ...e,
          protected: b64url(
            JSON.stringify({ alg: "dir", enc: "A256GCM" }),
          ).padEnd(60, "A"),
        },
        PLACE_ID,
      ),
    ).toBeNull();
    expect(
      parseEnvelope({ ...e, protected: "A".repeat(60) }, PLACE_ID),
    ).toBeNull();
    expect(
      parseEnvelope({ ...e, protected: "+".repeat(60) }, PLACE_ID),
    ).toBeNull();
  });

  it("refuses members the profile does not name, and wrong lengths", () => {
    const e = envelopeFor();
    expect(parseEnvelope({ ...e, unprotected: {} }, PLACE_ID)).toBeNull();
    expect(parseEnvelope({ ...e, encrypted_key: "x" }, PLACE_ID)).toBeNull();
    expect(parseEnvelope({ ...e, header: {} }, PLACE_ID)).toBeNull();
    expect(parseEnvelope({ ...e, iv: "short" }, PLACE_ID)).toBeNull();
    expect(parseEnvelope({ ...e, tag: "short" }, PLACE_ID)).toBeNull();
    expect(parseEnvelope({ ...e, ciphertext: "" }, PLACE_ID)).toBeNull();
    expect(
      parseEnvelope(
        { ...e, ciphertext: "A".repeat(MAX_ENVELOPE_CIPHERTEXT + 1) },
        PLACE_ID,
      ),
    ).toBeNull();
    expect(parseEnvelope("x", PLACE_ID)).toBeNull();
    const noTag = without(e, "tag");
    expect(parseEnvelope(noTag, PLACE_ID)).toBeNull();
  });
});

describe("mergeItem and mergeById: the later updatedAt wins", () => {
  it("takes the incoming item when nothing is stored", () => {
    expect(mergeItem(undefined, activity())).toEqual(activity());
  });

  it("takes a later write and keeps the first createdAt", () => {
    const stored = activity({ createdAt: T1, updatedAt: T1 });
    const incoming = activity({ createdAt: T2, updatedAt: T3 });
    expect(mergeItem(stored, incoming)).toEqual({
      ...incoming,
      createdAt: T1,
    });
  });

  it("leaves the stored item on an earlier write and on a tie", () => {
    const stored = activity({ updatedAt: T2 });
    expect(mergeItem(stored, activity({ updatedAt: T1 }))).toBe(stored);
    expect(
      mergeItem(stored, activity({ updatedAt: T2, tombstone: true })),
    ).toBe(stored);
  });

  it("lets a later live write revive a tombstone, and an earlier one not", () => {
    const gone = activity({ updatedAt: T2, tombstone: true });
    expect(mergeItem(gone, activity({ updatedAt: T3 })).tombstone).toBe(false);
    expect(mergeItem(gone, activity({ updatedAt: T1 })).tombstone).toBe(true);
  });

  it("lets a later removal beat an earlier edit", () => {
    const live = activity({ updatedAt: T1 });
    expect(
      mergeItem(live, activity({ updatedAt: T2, tombstone: true })).tombstone,
    ).toBe(true);
  });

  it("is a union across items and gives one answer in either order", () => {
    const a = [activity({ activityId: ACT, updatedAt: T1 })];
    const b = [
      activity({ activityId: ACT, updatedAt: T2, tombstone: true }),
      activity({ activityId: ACT2, updatedAt: T1 }),
    ];
    const ab = mergeById(a, b, activityIdOf);
    const ba = mergeById(b, a, activityIdOf);
    expect(ab).toEqual(ba);
    expect(ab.map((i) => [i.activityId, i.tombstone])).toEqual(
      expect.arrayContaining([
        [ACT, true],
        [ACT2, false],
      ]),
    );
  });

  it("orders by createdAt, then id", () => {
    const merged = mergeById(
      [],
      [
        activity({ activityId: ACT2, createdAt: T1 }),
        activity({ activityId: ACT, createdAt: T1 }),
        activity({ activityId: "zzz-late", createdAt: T2, updatedAt: T2 }),
      ],
      activityIdOf,
    );
    expect(merged.map((i) => i.activityId)).toEqual(
      [ACT, ACT2].sort().concat("zzz-late"),
    );
  });

  it("merges saved places on their own ids", () => {
    const id2 = "01934f6a-7b2c-7d3e-8a4f-5b6c7d8e9f02";
    const merged = mergeById(
      [place()],
      [place({ savedPlaceId: id2, envelope: envelopeFor(id2) })],
      savedPlaceIdOf,
    );
    expect(merged).toHaveLength(2);
  });
});

describe("capProblem", () => {
  const acts = (n: number, over: Partial<ActivityItem> = {}) =>
    ACTIVITIES.slice(0, n).map((a) => activity({ activityId: a.id, ...over }));
  const empty = { activities: [], savedPlaces: [] };

  it("allows a full list and refuses one more", () => {
    expect(
      capProblem(empty, {
        activities: acts(MAX_PERSON_ACTIVITIES),
        savedPlaces: [],
      }),
    ).toBeNull();
    expect(
      capProblem(empty, {
        activities: acts(MAX_PERSON_ACTIVITIES + 1),
        savedPlaces: [],
      }),
    ).toEqual({ status: 422, code: "too_many_activities" });
  });

  it("does not count tombstones against the cap", () => {
    const merged = {
      activities: [
        ...acts(MAX_PERSON_ACTIVITIES),
        activity({ activityId: "gone-1", tombstone: true }),
      ],
      savedPlaces: [],
    };
    expect(capProblem(empty, merged)).toBeNull();
  });

  it("lets a person who is over a cap (it was lowered) remove, not add", () => {
    const over = acts(MAX_PERSON_ACTIVITIES + 3);
    const stored = { activities: over, savedPlaces: [] };
    const removing = {
      activities: over.map((a, i) => (i === 0 ? { ...a, tombstone: true } : a)),
      savedPlaces: [],
    };
    expect(capProblem(stored, removing)).toBeNull();
    expect(
      capProblem(stored, {
        activities: [...over, activity({ activityId: "one-more" })],
        savedPlaces: [],
      }),
    ).not.toBeNull();
  });

  it("refuses more than the stored bound even when tombstones are the excess", () => {
    const tomb = Array.from({ length: MAX_STORED_ACTIVITIES + 1 }, (_, n) =>
      activity({ activityId: `t-${n}`, tombstone: true }),
    );
    expect(capProblem(empty, { activities: tomb, savedPlaces: [] })).toEqual({
      status: 422,
      code: "too_many_activities",
    });
  });

  it("caps saved places the same way", () => {
    const places = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        place({ savedPlaceId: placeId(i), envelope: envelopeFor(placeId(i)) }),
      );
    expect(
      capProblem(empty, {
        activities: [],
        savedPlaces: places(MAX_PERSON_SAVED_PLACES),
      }),
    ).toBeNull();
    expect(
      capProblem(empty, {
        activities: [],
        savedPlaces: places(MAX_PERSON_SAVED_PLACES + 1),
      }),
    ).toEqual({ status: 422, code: "too_many_places" });
  });
});

describe("toDocument", () => {
  it("is the empty person of the contract, with no updatedAt", () => {
    expect(toDocument([], [])).toEqual({
      schemaVersion: "v3.1",
      settings: {},
      activities: [],
      savedPlaces: [],
    });
  });

  it("carries the latest updatedAt of any item and the tombstones", () => {
    const doc = toDocument(
      [
        activity({ updatedAt: T2 }),
        activity({ activityId: ACT2, updatedAt: T1, tombstone: true }),
      ],
      [place({ updatedAt: T3 })],
    );
    expect(doc.updatedAt).toBe(T3);
    expect(doc.activities.some((a) => a.tombstone)).toBe(true);
  });
});
