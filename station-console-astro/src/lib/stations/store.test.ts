import { describe, expect, it } from "vitest";
import { addStation, loadStations, removeStation, replaceKey, saveStations, STORE_KEY } from "./store";

const memory = (initial?: string) => {
  const data = new Map<string, string>(initial === undefined ? [] : [[STORE_KEY, initial]]);
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};
const s1 = { stationId: "mws-00000001", key: "k1", name: "One", stationType: "digital" as const };
const s2 = { stationId: "mws-00000002", key: "k2", name: "Two", stationType: "manual" as const };

describe("station store", () => {
  it("uses the key and shape of the Next.js console", () => {
    expect(STORE_KEY).toBe("mws-console-stations");
    const m = memory();
    saveStations(m, [s1]);
    expect(JSON.parse(m.getItem(STORE_KEY)!)).toEqual([s1]);
  });
  it("loads valid entries and drops malformed ones", () => {
    expect(loadStations(memory(JSON.stringify([s1, { stationId: 1 }, "x", { ...s2, stationType: "weird" }])))).toEqual([s1]);
  });
  it("survives corrupt JSON, non-arrays and missing storage", () => {
    expect(loadStations(memory("{oops"))).toEqual([]);
    expect(loadStations(memory('{"a":1}'))).toEqual([]);
    expect(loadStations(null)).toEqual([]);
    expect(saveStations(null, [s1])).toBe(false);
  });
  it("reports a failing write instead of throwing", () => {
    expect(saveStations({ getItem: () => null, setItem: () => { throw new Error("quota"); } }, [s1])).toBe(false);
  });
  it("adds without duplicating, removes and replaces keys immutably", () => {
    const list = [s1];
    expect(addStation(list, { ...s1, key: "new" })).toEqual([{ ...s1, key: "new" }]);
    expect(addStation(list, s2)).toHaveLength(2);
    expect(removeStation([s1, s2], s1.stationId)).toEqual([s2]);
    expect(replaceKey([s1, s2], s2.stationId, "rot")[1]!.key).toBe("rot");
    expect(list).toEqual([s1]);
  });
});
