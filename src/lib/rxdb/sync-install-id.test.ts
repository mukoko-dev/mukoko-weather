/**
 * The id every sync document carries as `deviceId`: the validator accepts a
 * lower-case UUID and nothing else, so an app device id that is anything else
 * (an old build, a corrupt entry) is replaced by one of the sync's own, kept in
 * web storage and reused, and never blocks the sync.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDeviceId } from "./couch-docs";
import {
  SYNC_INSTALL_ID_KEY,
  _resetSyncInstallId,
  documentDeviceId,
} from "./sync-install-id";

const APP_ID = "5f0e1c2a-8b3d-4e6f-9a7b-1c2d3e4f5a6b";

let data: Map<string, string>;
let blocked: boolean;

beforeEach(() => {
  _resetSyncInstallId();
  data = new Map();
  blocked = false;
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => {
      if (blocked) throw new Error("SecurityError");
      return data.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (blocked) throw new Error("SecurityError");
      data.set(k, v);
    },
    removeItem: (k: string) => void data.delete(k),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("documentDeviceId", () => {
  it("uses the app's own device id as it is when the validator would accept it, and touches no storage", () => {
    expect(documentDeviceId(APP_ID)).toBe(APP_ID);
    expect([...data.keys()]).toEqual([]);
  });

  it.each([
    "device",
    "",
    "not-a-uuid",
    APP_ID.toUpperCase(),
    `${APP_ID}0`,
    " ",
  ])("replaces %j with a lower-case UUID of the sync's own", (bad) => {
    const id = documentDeviceId(bad);
    expect(isDeviceId(id)).toBe(true);
    expect(id).not.toBe(bad);
    expect(data.get(SYNC_INSTALL_ID_KEY)).toBe(id);
  });

  it("keeps it: the same id on the next call and on the next page, from storage", () => {
    const first = documentDeviceId("device");
    expect(documentDeviceId("device")).toBe(first);
    _resetSyncInstallId(); // a new page: only storage remains
    expect(documentDeviceId("device")).toBe(first);
  });

  it("ignores a stored value that is not a UUID and replaces it", () => {
    data.set(SYNC_INSTALL_ID_KEY, "garbage");
    const id = documentDeviceId("device");
    expect(isDeviceId(id)).toBe(true);
    expect(data.get(SYNC_INSTALL_ID_KEY)).toBe(id);
  });

  it("with web storage blocked it still answers a valid id, the same one for the page", () => {
    blocked = true;
    const id = documentDeviceId("device");
    expect(isDeviceId(id)).toBe(true);
    expect(documentDeviceId("device")).toBe(id);
  });

  it("two different installs get different ids", () => {
    const a = documentDeviceId("device");
    data.clear();
    _resetSyncInstallId();
    const b = documentDeviceId("device");
    expect(a).not.toBe(b);
  });

  it("works without crypto.randomUUID", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        for (let i = 0; i < bytes.length; i += 1)
          bytes[i] = (i * 37 + 11) & 255;
        return bytes;
      },
    });
    const id = documentDeviceId("device");
    expect(isDeviceId(id)).toBe(true);
    expect(id[14]).toBe("4"); // version 4
    expect("89ab").toContain(id[19]); // variant 10
  });
});
