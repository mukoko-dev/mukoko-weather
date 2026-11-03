# CouchDB sync of preferences and activities

Tracking issue: mukoko-dev/mukoko-weather#396 (web slice). The code is behind
`FLAGS.couch_sync`, which is **off by default**. With it off a visitor sees and
costs nothing: no sync code in the first-load JavaScript, no IndexedDB database
and no request to `/api/couch/*` or the API host. The existing `/v1/devices`
replication (`src/lib/rxdb/replication.ts`, `device-profile.ts`) is untouched
and keeps running.

## What it does

With the flag on, the device's `theme`, `selectedForecastModel` and
`selectedActivities` replicate with the signed-in person's own CouchDB database
`user_<personId>`, through the Nyuchi API (`https://api.nyuchi.com/v1/couch/db/...`),
offline first (RxDB on the device).

- **Plaintext types only.** The documents are `preference:theme`,
  `preference:forecastModel` and `activity:<activityId>`
  (`src/lib/rxdb/couch-docs.ts`). Saved places, the home place, history,
  interests, engagement and device notes are ciphertext envelopes whose keys
  live on the device; the key-custody design is not decided, so none of them
  syncs from here and nothing locational is ever written in plaintext.
  `assertPlaintextDoc` gates every pushed document, and the fetch layer drops
  every other id from `_changes` (`isOwnedDocId`), so a type this client does
  not own is neither stored nor pushed.
- **Gate.** `initializeDeviceSync()` calls `startCouchSyncIfEnabled()`
  (`src/lib/store.ts`), which reads the flag and only then does a dynamic
  `import("./rxdb/couch-sync-start")`; that file reads the flag again before
  importing the engine, the RxDB layer or the session client.
  `couch-sync-flag-off.test.ts` guards behaviour and imports.
- **Own database.** One RxDB database per person,
  `mukoko_weather_sync_<personId>`, collection `user_docs`
  (`src/lib/rxdb/couch-rxdb.ts`), never in `mukoko_weather`, so a second person
  signing in on the device cannot push the first person's documents.
- **Cycles, not a stream.** The gateway refuses continuous and event-source
  feeds, so replication is `live: false`: each cycle is one pull
  (`_changes?feed=normal`) and one push (`_all_docs` POST, `_bulk_docs`), then
  it cancels itself. A cycle starts on a 60 s timer while the page is visible,
  on focus or becoming visible (15 s cooldown), on `online`, and after a local
  write (written after 750 ms, pushed after 2 s).
- **Defaults never win.** A device that did not change a setting writes nothing
  for it, and seeding after the first pull fills only ids that have no document
  at all. Conflicts: last writer wins by `updatedAt`, the revision CouchDB chose
  on a tie, and a delete from the server (which carries no time) wins.
- **Failures are silent and bounded.** 401 from the session route means signed
  out (idle); 401 from the database means fetch a new credential once, then back
  off; 403, 404, 429, 5xx, offline and timeouts back off 30 s doubling to 15 min
  and the app stays local-only (`src/lib/rxdb/couch-sync.ts`,
  `couch-schedule.ts`).
- **Document shape follows the validator that runs in CouchDB, not the
  generated schema.** nyuchi-api `gateway/lib/couch_validate_personal.js` (pinned
  in `src/lib/rxdb/__fixtures__/`, executed by the tests) requires an integer
  `schemaVersion`, `ownerPersonId` equal to the signed-in person, and a tombstone
  of `_id`, `_rev`, `_deleted` only. data-infra's generated schemas say
  `schemaVersion: "v3.1"`, have no `ownerPersonId` and keep common fields on a
  tombstone, and name four types in camelCase (`savedPlace`, `engagementEvent`,
  `historyEntry`, `deviceNote`) that the validator refuses (its `type` is lower
  case). Reconcile the two before the encrypted types.

## The credential: the gateway's sync grant

The page cannot sign in to the gateway: this site signs in through its own
server-side WorkOS AuthKit session and never holds a gateway sign-in token. The
gateway's `couch:user` **sync grant** (nyuchi/nyuchi-api #475, released in
v0.53.0, design in nyuchi-api `docs/architecture/couchdb-sync-grant.md`) is the
credential a site like this can obtain:

```text
page (flag on)
  | POST /api/couch/session            same origin, JSON, signed in, per-user limit
  v
site server  (src/lib/couch-session-issuer.ts)
  | POST {gateway}/v1/auth/token       RFC 8693, scope=couch:user ALONE,
  |                                    subject = the person's WorkOS access token,
  |                                    this app's own internal key
  v
gateway -> a grant: aud=couch-sync, scope=couch:user, act.sub = the key's client id,
           5 minutes at most, never past the WorkOS token, cannot be refreshed
  |
  v
page: { token, expiresAt, database, apiOrigin } --> POST {api}/v1/couch/personal  (once per run)
                                                --> replication on {api}/v1/couch/db/user_<personId>/
```

The grant is the bearer for replication and only that: the gateway accepts it
on `/v1/couch/db/user_<own id>/...` and `POST /v1/couch/personal` and nowhere
else (`POST /v1/couch/session` and every other route refuse it). A full sign-in
token never reaches page JavaScript, and the browser never sees the WorkOS
token or the key.

### Verified against nyuchi-api `staging` (read 2026-11-03, after v0.53.0)

| Fact                                                                                                                                                                                                                                                                                             | Where                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| The scope is requested alone; anything else with it is `400 invalid_scope`                                                                                                                                                                                                                       | `gateway/lib/token_exchange.py` `check_sync_request`, l.614-632           |
| Only a client on `COUCH_SYNC_CLIENT_IDS` may ask. That list holds the exchanging **key's** client id (`nyk_...`), not a WorkOS client id: the exchange passes `ctx["client_id"]`, and the grant's `act.sub` is the same id                                                                       | `gateway/routers/auth.py` l.348-354; `gateway/lib/jwt.py` l.373-388       |
| The key needs no new scope: it must be an internal key holding `identity` (the one `/api/app-keys` already uses); key scopes are catalogue slugs, so the allow-list is the grant. (A comment in `gateway/lib/config.py` l.197 says the key must also hold the scope; the code does not check it) | `gateway/routers/auth.py` l.311-323; `token_exchange.py` l.614-632        |
| The subject token is verified as for any exchange: issued to the gateway's `WORKOS_CONSOLE_CLIENT_ID` (the Mukoko Account client this app signs in through, `WORKOS_CLIENT_ID`); `client_id` claim else `aud`, never `iss`                                                                       | `token_exchange.py` `verify_subject_token`, l.369-441                     |
| Lifetime is `min(300 s, the subject token's remaining life)`, audience `couch-sync`                                                                                                                                                                                                              | `token_exchange.py` l.635-637; `jwt.py` l.368-370                         |
| A person with a scheduled deletion gets `400 invalid_grant`, "This person's deletion is scheduled."; 30 exchanges a minute per person (`429 slow_down`)                                                                                                                                          | `routers/auth.py` l.499-517                                               |
| The grant opens only `user_<own id>` and `POST /v1/couch/personal`; the allow-list is checked at every use, so removing a client stops its grants                                                                                                                                                | `routers/couch.py` l.76-94, l.314-330; `routers/couch_proxy.py` l.105-110 |
| The replication route never creates a database, so `POST /v1/couch/personal` must run first (30 a minute per IP)                                                                                                                                                                                 | `routers/couch_proxy.py` l.23; `routers/couch.py` l.314-330               |
| CORS for `/v1/couch/*` allows `https://weather.mukoko.com` (GET, HEAD, POST, PUT, DELETE, OPTIONS; headers `Authorization`, `Content-Type`, `If-Match`, `If-None-Match`, `Accept`; no credentials)                                                                                               | `gateway/main.py` l.412-433                                               |

### What this repo does with it

- `src/lib/couch-session-issuer.ts` makes the grant with the same exchanger as
  `/api/app-keys` (`src/lib/gateway-person-token.ts`, parameterised by scope),
  so the transport, the in-flight dedupe, the short negative cache and the
  "never send another client's WorkOS token" guard are shared, not copied.
  Every request gets a new grant (`maxCacheMs: 0`); a grant with a minute left
  would be due for renewal the moment it arrived. It reads the person id from
  the grant (the exchange answer does not say) and refuses anything that is not
  exactly a sync grant (audience, scope, actor, lifetime, id shape) before the
  page sees it.
- **Fail closed.** Without `NYUCHI_API_URL` (a bare https origin),
  `NYUCHI_APP_KEYS_API_KEY` or `WORKOS_CLIENT_ID` the issuer is `null` and
  `POST /api/couch/session` answers `503 couch_unavailable` without calling
  anything. The same 503 is what the page sees until the owner steps below are
  done. **No new secret and no new environment variable.**
- **Errors.** A session that ended is `401 reauth_required`; a scheduled
  deletion is `403 account_pending_deletion` (the only wire difference from an
  ended session is the gateway's sentence, so the match is a convenience: if the
  text changes the person is told to sign in again, which is safe); `429` keeps
  the gateway's `Retry-After`; everything else (the client not on the allow-list,
  an unconfigured key, a 5xx, a timeout, an unreadable answer, no linked person)
  is `503 couch_unavailable`, which the page backs off on.
- **The WorkOS token must have life left.** The grant never outlives the
  access token, and the page renews it a minute before it ends. A grant made
  from a token with a minute left would be due on arrival, and the page would
  ask again at once; measured against a fake gateway that is a burst of dozens of
  exchanges in seconds. So the proxy refreshes the access token on
  `/api/couch/session` (and only there) when it has under 120 s left
  (`authkit(request, { refreshBufferSeconds })`, `src/proxy.ts`), and the issuer
  will not exchange a token with under 90 s left (`src/lib/couch-session-timing.ts`):
  it answers `503` and the page backs off. This assumes WorkOS access tokens last
  the default five minutes; with a much shorter lifetime the sync cannot run.
- **Limits.** The route allows 120 requests an hour per person (a visible tab
  asks about every four minutes, 15 an hour); the gateway holds a person to 30
  exchanges a minute on top. **The gateway also limits `POST /v1/auth/token` to
  30 a minute per key**, unless the key is on `CONSOLE_BACKEND_CLIENT_IDS` or
  `WORKOS_USER_CLIENT_IDS` (1200 a minute): `gateway/lib/security.py`
  `token_endpoint_limit`, l.214-223. This site has one key for every person, and
  `/api/app-keys` uses it too. At one renewal per visible tab every four minutes
  that is room for roughly 120 tabs syncing at once; beyond it exchanges answer
  `429` (the page backs off and nothing breaks, but `/api/app-keys` shares the
  ceiling). So a wide rollout of the flag needs a gateway decision about this
  key's ceiling, which is not made here.
- **The page** prepares the database once per person per run with
  `POST {api}/v1/couch/personal` (`ensurePersonalDatabase`,
  `src/lib/rxdb/couch-session.ts`), again after a 404 from the database, then
  replicates with the grant as the bearer (`couch-fetch.ts`; no cookie ever
  travels to the API host).

## Owner steps to turn it on

Nothing below was done by the code change, and none of it needs a new secret.

1. **Allow-list this app's key on the gateway.** On the Fly app `nyuchi-api`, set
   `COUCH_SYNC_CLIENT_IDS` to include the client id of the key
   `NYUCHI_APP_KEYS_API_KEY` holds: the `nyk_...` part before the dot, which is a
   public identifier. The secret half (`nys_...`) never goes in the list. (The
   list takes the exchanging key's client id; it is not the WorkOS client id.)
   The key keeps its scopes (`identity app-keys weather`); no scope change.
   Until this is set the exchange answers `400 invalid_scope`, this site answers
   `503`, and the server log has the line "Token exchange refused this app's key"
   with `status: 400, error: invalid_scope` (no secret in it).
2. **Enable CouchDB's JWT handler** as described in nyuchi-api
   `docs/architecture/couchdb-sync.md`. Until then every forwarded request is
   refused by CouchDB with 401.
3. **Check** the Vercel environment holds `NYUCHI_API_URL`,
   `NYUCHI_APP_KEYS_API_KEY` and `WORKOS_CLIENT_ID` (they already do for
   `/api/app-keys`), that `WORKOS_CLIENT_ID` is the client the gateway has as
   `WORKOS_CONSOLE_CLIENT_ID`, and that WorkOS access tokens use the default
   five-minute lifetime.
4. **Live check**, once 1 and 2 are done: in a signed-in browser run
   `localStorage.setItem("ff:couch_sync","true")`, reload, change the theme and
   open the Network tab. Expect `POST /api/couch/session` 200, then on
   `api.nyuchi.com`: `POST /v1/couch/personal` 200, `GET .../_changes` 200,
   `POST .../_all_docs` 200, `POST .../_bulk_docs` 201, and no request refused.
   Sign in on a second device with the flag on: the theme and activities arrive
   on its first cycle. Only then consider flipping `FLAGS.couch_sync`.

## Not verified

The tests cover the issuer, the exchange rules (a fake gateway that ports the
rules above and names its sources, `src/lib/test-support/fake-nyuchi-gateway.ts`),
the route, the proxy option, the engine and the whole chain on a manual clock
with real RxDB (memory storage) against an in-memory CouchDB that applies the
gateway's request allow-list and runs the pinned `validate_doc_update`. Nothing
was sent to any production endpoint. Only a live run can show: the real gateway
(signing, its limits, the key and the allow-list), CORS from a real browser, the
CouchDB JWT handler accepting the gateway's token, the real CouchDB and PouchDB
revision behaviour, IndexedDB, a real browser's focus, visibility and `online`
events, and the CSP (`https://api.nyuchi.com` is in `connect-src`).

## Next slice

`savedPlace`, `preference:homePlace`, `interest`, `engagementEvent`,
`historyEntry` and `deviceNote` as JWE envelopes (`alg: dir`, `A256GCM`, `aad`
the base64url of the `_id`). Open: where the device key lives and how a second
device gets it; recommended, not decided, a non-extractable WebCrypto key in
IndexedDB wrapped by a passphrase- or passkey-derived key, with a short ADR in
data-infra first. The camelCase-type refusal above must be fixed on one side
before any of those can be written.
