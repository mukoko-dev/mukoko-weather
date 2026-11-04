/**
 * The mark left by the first "nobody is signed in" answer from the credential
 * route (#396): the engine's `SignedOutMarker`, kept in web storage so the next
 * page load can see it.
 *
 * Why it exists. Removing the local copy of a person's settings cannot be
 * undone, and one `401 signed_out` is not proof: the session cookie can be gone
 * for a reason that is not a sign-out (AuthKit's refresh token is single-use,
 * and two requests racing for it leave one of them without a session; the
 * route answers a cookie WITH no user as 503 for that reason, but a cookie
 * deleted by the loser of such a race is a 401 on the next request). So the
 * first such answer only leaves this mark and idles; the copy is removed when a
 * LATER page load, at least a minute after the mark, hears it again. Any
 * successful session removes the mark.
 *
 * What it holds. One number: the time of the first answer. No person, no
 * place, no name, no credential. A separate module from the `couch-*` files on
 * purpose, like `sync-pending.ts` and `sync-people-index.ts`: those are guarded
 * against touching web storage because the credential must live in memory only
 * (`couch-sync-flag-off.test.ts`). It is only reached once the sync has
 * started, which only happens with `FLAGS.couch_sync` on.
 */

import { readStorage, removeStorage, writeStorage } from "../safe-storage";
import type { SignedOutMarker } from "./couch-sync";

export const SYNC_SIGNED_OUT_KEY = "mukoko-sync-signed-out";

const MAX_RAW_CHARS = 20;

export const signedOutMarker: SignedOutMarker = {
  read(): number | null {
    const raw = readStorage(SYNC_SIGNED_OUT_KEY);
    if (!raw || raw.length > MAX_RAW_CHARS || !/^\d+$/.test(raw)) return null;
    const at = Number(raw);
    return Number.isFinite(at) && at > 0 ? at : null;
  },

  write(atMs: number): void {
    if (!Number.isFinite(atMs) || atMs <= 0) return;
    writeStorage(SYNC_SIGNED_OUT_KEY, String(Math.floor(atMs)));
  },

  clear(): void {
    removeStorage(SYNC_SIGNED_OUT_KEY);
  },
};
