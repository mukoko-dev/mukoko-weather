/**
 * The `deviceId` the sync writes into its documents.
 *
 * The data model's `deviceId` is a lower-case UUID, and the validator on a
 * person's database refuses a document whose `deviceId` is anything else (and a
 * refused write holds up everything pushed with it). The app's own device id
 * (`getDeviceId()`, kept in `localStorage` for the `/v1/devices` profile) is a
 * UUID the app generated, but it is a stored string like any other: an old
 * build, a hand edit or a corrupt entry can leave something that is not. So the
 * starter asks here first. A device id that is a lower-case UUID is used as it
 * is (one install, one id, the same one the device profile uses); anything else
 * is replaced by a UUID of its own for the sync, kept in web storage and reused,
 * so sync still works and the id still names one install. With web storage
 * blocked the id lasts for the page (a different install id per page load is
 * harmless: it only says which install wrote a document).
 *
 * A separate module from the `couch-*` files on purpose, like `sync-pending.ts`
 * and `sync-signed-out.ts`: those are guarded against touching web storage
 * (`couch-sync-flag-off.test.ts`). It is reached only once the sync has started,
 * which only happens with `FLAGS.couch_sync` on. It holds no person and no place.
 */

import { readStorage, writeStorage } from "../safe-storage";
import { isDeviceId } from "./couch-docs";

export const SYNC_INSTALL_ID_KEY = "mukoko-sync-install-id";

/** The id made for this page when web storage would not keep one. */
let pageId: string | null = null;

function randomUuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A device id the validator accepts: the app's own when it is one, else the sync's. */
export function documentDeviceId(appDeviceId: string): string {
  if (isDeviceId(appDeviceId)) return appDeviceId;
  const stored = readStorage(SYNC_INSTALL_ID_KEY);
  if (isDeviceId(stored)) return stored;
  pageId ??= randomUuid();
  writeStorage(SYNC_INSTALL_ID_KEY, pageId);
  return pageId;
}

/** For tests: forget the id made for this page. */
export function _resetSyncInstallId(): void {
  pageId = null;
}
