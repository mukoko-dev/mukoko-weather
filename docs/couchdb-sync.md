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
- **Own database, and whose it is.** One RxDB database per person,
  `mukoko_weather_sync_<personId>`, collection `user_docs`
  (`src/lib/rxdb/couch-rxdb.ts`), never in `mukoko_weather`, so a second person
  signing in on the device cannot push the first person's documents. It holds
  that person's settings and activities, so it does not outlive their sign-in
  on the browser: opening it records the person's id (ids only, in
  `localStorage` through `safe-storage`, `src/lib/rxdb/sync-people-index.ts`,
  written before the database exists), and `purgeUserDocStores` closes and
  removes every recorded database but the signed-in person's: when
  `/api/couch/session` answers 401 (nobody is signed in, including the first
  request of an anonymous visitor on a browser an earlier sign-in used), and
  once per run for the person who is signed in (a different person being issued
  removes the previous person's). A database that cannot be removed (IndexedDB
  blocked or missing, another tab holding it past 5 s) stays recorded and is
  tried again at the next run; nothing throws into the page. With the flag off
  none of this runs and nothing is read or created. If the flag is turned off
  after having been on, a database that was left behind stays until the flag is
  on again and someone signs out or in; clearing site data removes it too. A
  transient 401 (the AuthKit session failing to refresh for a moment) also
  clears the local mirror: the settings are still in the app's own preferences
  and on the server, and the next signed-in page load pulls them again, but a
  change made while offline that had not been written to a document yet would
  then lose to the server's value.
- **One tab replicates.** Every tab of the browser opens the same IndexedDB
  database (`multiInstance: true`) and RxDB elects one leader tab; the
  replication waits for leadership (`waitForLeadership: true`, as
  `replication.ts` does). The engine asks `isLeader()` first: a follower writes
  the person's own changes into the shared database, applies what is in it
  (soon after the leader pulled it, via the shared-database change events),
  never seeds, and asks for no credential of its own. A hidden leader does not
  poll, but it replicates when another tab wrote into the shared database, so a
  visible follower's change is not stranded behind a background tab. Leadership
  is asked before the credential, which is possible because the database is
  already open, so a follower makes no credential request at all (the route's
  120 an hour per person and the gateway's 30 a minute per key are not spent by
  it); only a browser with no database yet, a person's first session, has every
  tab ask once before it can know. When the leader tab closes, the next cycle of
  another tab takes over. **Not verified
  in a real browser**: two tabs cannot be started in this environment (RxDB
  refuses two databases of one name in one JavaScript process, and the memory
  storage has no second process); the options passed to RxDB are pinned
  (`couch-rxdb-options.test.ts`) and the engine's behaviour is tested with a
  store that reports its leadership.
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
- **The local database opens at start, with no network and no credential.**
  It is purely on-device. When the browser already holds exactly one person's
  database (the id record above), the engine opens it first thing
  (`recordedPerson` in `couch-sync-start.ts`) and writes the person's changes to
  it as soon as the 750 ms debounce ends, offline too. Which person's? The one
  recorded; that is a guess until the credential says who is signed in, and if it
  was wrong (another person signed in on this browser) the engine closes that
  database, starts the right person's own, and writes what the person changed
  since the page started to it. A browser with no database yet, or with several
  recorded, opens it when the first credential arrives, as before.
- **A change is never only in memory.** The moment a synced setting changes, the
  engine records (synchronously, in `localStorage` through `safe-storage`,
  `src/lib/rxdb/sync-pending.ts`, key `mukoko-sync-unwritten`) the state the
  person started from and when they changed it: a time and the three
  non-locational settings, no credential, no place, no name. The record is
  cleared once the change is in a document, and on sign-out; an engine clears
  only a record it wrote, so another tab's pending change is never forgotten. A
  page that closes inside the debounce, before any local database exists (a
  person's first session) or while the credential keeps failing leaves the
  record behind, and the next page starts its comparison from it instead of from
  the state it finds, so the change is still a change: written when the database
  opens, stamped with when it was made, and ordered against the server's value
  by that time. Before this the next page saw no difference, pulled the server's
  older value and reverted the person's choice. `stop()` (`pagehide`) and
  `flush()` (the page was hidden: mobile browsers often kill a hidden page
  without a `pagehide`) also write at once. What the engine applies from the
  server is not the person's change and is never recorded. Web storage that is
  blocked costs only this second layer: the change is still written to the local
  database after the debounce.
- **The stamp is when the person made the change.** The baseline the engine
  compares against is taken at `start()` (from the record when the last page left
  one), not when the database opens, and a change is stamped with when it was
  made, so it wins against an older value on the server and loses against a newer
  one. A change made while the first replication runs is written before anything
  is seeded or applied, from the state already written, and is pushed by the
  second replication of that cycle; seeding never replaces the baseline with a
  fresh read that includes an unwritten change.
- **The person's own order of activities is kept.** The AI advice looks at the
  first three; a remote add is appended, a remote remove drops that id, and the
  order of the documents (oldest first, then by id) is used only for ids the
  device does not hold yet.
- **Only what this app offers is applied.** The forecast models that sync are
  the web app's own (`ForecastModel` in `weather.ts`, the My Weather picker; all
  are in the Worker's device-profile allowlist), not the data model's wider list:
  a model another client set that this app does not offer (`jma_gsm`,
  `ukmo_global_deterministic_10km`, `cma_grapes_global`) is ignored and never
  replaces the person's own pick here, and the Météo-France pick the picker
  offers (`meteofrance_seamless`, which data-infra's schema does not list; the
  deployed validator does not check values) syncs. Activities from another
  client are applied only if the app knows the id (`src/lib/activities.ts`, equal
  to the Worker's allowlist) and only up to 30, the device profile's limit,
  after the ones the person already holds; nothing they hold is dropped to make
  room. An unknown activity document is left in the local database and never
  applied.
- **Failures are silent and bounded.** 401 from the session route means nobody
  is signed in: the engine goes idle until the next page load, with no failure
  count, no timer and no second request (see "Own database" for what it removes).
  401 from the database means fetch a new credential once, then back off; 403,
  404, 429, 5xx, offline and timeouts back off 30 s doubling to 15 min and the
  app stays local-only (`src/lib/rxdb/couch-sync.ts`, `couch-schedule.ts`). A
  credential with under 75 s left when it arrives is a failure too, and two
  credential fetches are never closer than 5 s (`src/lib/couch-session-timing.ts`),
  so a short-lived grant cannot make a loop.
- **Teardown.** `pagehide` stops the engine (timers, listeners, the credential
  and the open database go; a change still inside the debounce is written
  first, best effort); a page restored from the back/forward cache starts it
  again. A hidden page writes its pending change at once (`visibilitychange`).
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
- **401 means signed out, and only that.** The page answers a 401 from the
  session route by removing its local copy of the person's settings, so the
  route gives 401 only when nobody is signed in (`401 unauthorized`, ahead of the
  configuration check and the limiter) or the gateway itself refuses the
  person's WorkOS token. A person who IS signed in whose access token is missing or has ended
  (AuthKit's refresh failing for a moment, WorkOS answering 5xx) is
  `503 couch_unavailable`: the page keeps its local database and retries after
  the back-off. The gateway's own refusal of the subject token is still
  `401 reauth_required` (it is the same mapping `/api/app-keys` has); that one
  can in principle also come from an expired token the gateway saw before this
  server did, which is not changed here. The route checks that sync is set up
  here (`NYUCHI_API_URL`, the app's key, `WORKOS_CLIENT_ID`) before it spends
  the person's hourly allowance, so an unconfigured site answers 503 without a
  Mongo write. The route's address is defined once, in
  `src/lib/couch-session-timing.ts` (`COUCH_SESSION_PATH`), which the page's
  client and the proxy import; a test pins it to the folder the route lives in
  and to there being no second spelling.
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
- **The CSP and `NYUCHI_API_URL`.** The page replicates with the host
  `/api/couch/session` hands it, which is `NYUCHI_API_URL`. The Content Security
  Policy table (`src/lib/security-headers.ts`) is pure data and never reads the
  environment, so it lists the default API origin, `https://api.nyuchi.com`
  (`NYUCHI_API_DEFAULT_ORIGIN`, pinned equal to the CSP entry by a test). When
  `NYUCHI_API_URL` is another origin, `next.config.ts` appends that origin to
  `connect-src` at build time (`couchApiConnectSrc(process.env)`), so the
  variable must be set when the app is built, and changing it needs a rebuild
  and redeploy, not only a restart. A `NYUCHI_API_URL` the policy cannot use (not
  a bare https origin) adds nothing. **The policy still ships as
  `Content-Security-Policy-Report-Only`**: a host missing from `connect-src`
  would be reported at `/api/csp-report` but not blocked, and it will be blocked
  once the policy is enforced, which is why the two have to match first.
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
events, and the CSP (`https://api.nyuchi.com` is in `connect-src`, and the policy
is report-only).

Also not verified, because the test storage cannot show it:

- **Leader election across real tabs.** RxDB refuses a second database of the
  same name in one process, so two tabs cannot be run here. The options
  (`multiInstance: true`, leader election, `waitForLeadership: true`) are pinned
  by a test and the engine's leader and follower paths are tested with a store
  that reports leadership; whether two real tabs elect one leader, and how fast a
  new one takes over, is for a live check with two tabs.
- **Removing the local database after sign-out** (`removeRxDatabase` on
  IndexedDB) in a real browser, including a browser that blocks the removal or
  has the database open in another tab. The code never throws and the person's
  id stays in the index until the removal succeeds; the memory storage used in
  tests removes cleanly.
- **`pagehide` and the back/forward cache.** The engine stops on `pagehide` and
  starts again on a persisted `pageshow`; real browsers differ in whether they
  fire these for every kind of unload. Whether an IndexedDB write begun in
  `pagehide` or `visibilitychange` completes before the page is killed also
  differs; that is what the synchronous record in `localStorage` is for, and it
  too has only been run against a stubbed `localStorage`.
- **Opening the local database before the credential in a real browser**:
  that a browser which holds one person's database really opens it offline at
  start, that RxDB's multi-instance and the leader election then behave with the
  database opened at start by every tab, and that the guess "the one recorded
  person" is right in practice. The engine tests use an in-memory store and the
  end-to-end tests RxDB's memory storage; neither is IndexedDB.
- **IndexedDB being blocked or missing** (private windows, some webviews). The
  sync is skipped silently and the index still records the person; the browser
  paths were simulated, not run.

## Next slice

`savedPlace`, `preference:homePlace`, `interest`, `engagementEvent`,
`historyEntry` and `deviceNote` as JWE envelopes (`alg: dir`, `A256GCM`, `aad`
the base64url of the `_id`). Open: where the device key lives and how a second
device gets it; recommended, not decided, a non-extractable WebCrypto key in
IndexedDB wrapped by a passphrase- or passkey-derived key, with a short ADR in
data-infra first. The camelCase-type refusal above must be fixed on one side
before any of those can be written.
