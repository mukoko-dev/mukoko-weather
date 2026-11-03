/**
 * Timing shared by the proxy (edge), the sync-grant issuer (server) and the
 * page's sync engine so they cannot drift. Dependency free on purpose: the
 * proxy and the browser bundle import it.
 *
 * WHY. The sync grant (`couch:user`) never outlives the WorkOS access token it
 * was exchanged from (nyuchi-api `token_exchange.sync_lifetime`: the shorter of
 * 300 s and the token's remaining life). The page renews the grant a minute
 * before it ends (`REFRESH_LEAD_MS` in `rxdb/couch-schedule.ts`) and treats
 * anything with less than a minute left as already due. A grant made from an
 * access token with a minute to live would therefore be due the moment it
 * arrives, and the page would ask again at once, and again, until AuthKit's own
 * refresh (30 s before expiry by default) replaced the token: a burst of
 * exchanges that spends the person's hourly allowance for nothing.
 *
 * So the ends agree on floors:
 *
 *   - the proxy refreshes the access token on this one route when it has less
 *     than `COUCH_ACCESS_TOKEN_REFRESH_BUFFER_SECONDS` left (an AuthKit option,
 *     per call, `authkit(request, { refreshBufferSeconds })`);
 *   - the issuer will not exchange a token with less than
 *     `COUCH_MIN_ACCESS_TOKEN_LIFE_MS` left (the refresh failed for a moment):
 *     it answers `couch_unavailable`, which the page backs off on, instead of
 *     issuing a grant that is due on arrival;
 *   - the page keeps its own floors too, because the server's can be missed (a
 *     clock that is off, a token just above the floor): a credential with under
 *     `COUCH_MIN_GRANT_LIFE_MS` left is a failure that goes through the
 *     ordinary back-off, and two credential fetches are never closer than
 *     `REFRESH_MIN_DELAY_MS`.
 *
 * The proxy buffer is above the issuer's floor, so a refresh that works always
 * clears it; every grant the issuer lets through is longer than the page's
 * floor, and the page's floor is longer than its renewal lead.
 */

/** The route the page asks for a sync grant on. */
export const COUCH_SESSION_PATH = "/api/couch/session";

/** Refresh the WorkOS access token on `COUCH_SESSION_PATH` below this many seconds of life. */
export const COUCH_ACCESS_TOKEN_REFRESH_BUFFER_SECONDS = 120;

/** The least life, in ms, an access token may have for a grant to be made from it. */
export const COUCH_MIN_ACCESS_TOKEN_LIFE_MS = 90_000;

/**
 * The least life, in ms, a credential may have when the page receives it. Below
 * this it is a failure (and backs off), not a credential. Under the issuer's
 * floor, so a grant made from a token that just clears it is accepted, and
 * over the page's renewal lead (60 s), so an accepted one is never due on
 * arrival.
 */
export const COUCH_MIN_GRANT_LIFE_MS = 75_000;

/** Two credential fetches are never closer than this, whatever the credential says. */
export const REFRESH_MIN_DELAY_MS = 5_000;
