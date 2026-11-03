/**
 * Timing shared by the proxy (edge) and the sync-grant issuer (server) so the
 * two cannot drift. Dependency free on purpose: the proxy imports it.
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
 * So the two ends agree on a floor:
 *
 *   - the proxy refreshes the access token on this one route when it has less
 *     than `COUCH_ACCESS_TOKEN_REFRESH_BUFFER_SECONDS` left (an AuthKit option,
 *     per call, `authkit(request, { refreshBufferSeconds })`);
 *   - the issuer will not exchange a token with less than
 *     `COUCH_MIN_ACCESS_TOKEN_LIFE_MS` left (the refresh failed for a moment):
 *     it answers `couch_unavailable`, which the page backs off on, instead of
 *     issuing a grant that is due on arrival.
 *
 * The buffer is above the floor, so a refresh that works always clears it.
 */

/** The route the page asks for a sync grant on. */
export const COUCH_SESSION_PATH = "/api/couch/session";

/** Refresh the WorkOS access token on `COUCH_SESSION_PATH` below this many seconds of life. */
export const COUCH_ACCESS_TOKEN_REFRESH_BUFFER_SECONDS = 120;

/** The least life, in ms, an access token may have for a grant to be made from it. */
export const COUCH_MIN_ACCESS_TOKEN_LIFE_MS = 90_000;
