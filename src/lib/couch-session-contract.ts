/**
 * What the credential route (`POST /api/couch/session`) and the page's sync
 * agree on that is not timing: the name of a person's database, and the one
 * code a 401 carries when, and only when, nobody is signed in.
 *
 * Dependency free on purpose, like `couch-session-timing.ts` and
 * `bare-origin.ts`: the server's issuer and route import it, and so do the page's
 * client and the document module. None of them has to import the sync engine's
 * modules (and with them the activity catalogue and the Open-Meteo client) to
 * learn how a database is named.
 */

/**
 * The `error` of the route's 401 when nobody is signed in. The page removes its
 * local copy of the person's settings only on a 401 that carries it: a 401 or
 * any other status without it (a refresh that failed for a moment, the gateway
 * refusing a token, a misconfiguration) is a failure to retry, because the local
 * copy may hold the only record of a change made offline.
 */
export const SIGNED_OUT_CODE = "signed_out";

/** `user_<personId>`: a CouchDB database name made of lower-case characters. */
const PERSONAL_DB_RE = /^user_([a-z0-9][a-z0-9_-]{0,127})$/;

/** The person id inside a `user_<personId>` database name, else null. */
export function personIdFromDatabase(database: unknown): string | null {
  if (typeof database !== "string") return null;
  const match = PERSONAL_DB_RE.exec(database);
  return match ? match[1] : null;
}
