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
  removes every recorded database but the signed-in person's, in two cases:
  once per run for the person who is signed in (a different person being issued
  removes the previous person's: a signed credential names them, so that is
  certain), and when `/api/couch/session` has answered `401 signed_out` (nobody
  is signed in) **on two page loads** at least a minute apart (see "401 means
  signed out"). Removing a person's local copy and the record of their
  unwritten changes cannot be undone, and one 401 is an inference, so the first
  one only leaves a mark (`src/lib/rxdb/sync-signed-out.ts`, one number: the
  time) and idles; any session that is issued removes the mark. A 401 without
  the `signed_out` code, a session cookie with no user (a refresh that failed
  for a moment), a refused exchange and every 5xx remove nothing and leave no
  mark. A database that cannot be removed
  (IndexedDB blocked or missing, another tab holding it past 5 s) stays recorded
  and is tried again at the next run; nothing throws into the page. A browser
  that has had more than eight people's databases recorded forgets the oldest
  record without removing the database (nothing in a normal use gets there).
  With the flag off none of this runs and nothing is read or created. If the
  flag is turned off after having been on, a database that was left behind
  stays until the flag is on again and someone signs out or in; clearing site
  data removes it too.
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
  (`POST _changes?feed=normal&filter=_doc_ids`, see the next bullet) and one push
  (`_all_docs` POST, `_bulk_docs`), then it cancels itself. A cycle starts on a
  60 s timer while the page is visible, on focus or becoming visible (15 s
  cooldown), on `online`, and after a local write (written after 750 ms, pushed
  after 2 s).
- **The pull asks for this client's documents only.** Other clients keep
  documents in the same database (the mobile app's ciphertext interests, saved
  places, one event per interaction). RxDB's pull stops WITHOUT saving its
  checkpoint when a page has no documents, and counts a page with fewer
  documents than its batch (200) as the end of the feed; rows dropped after the
  server sent them would therefore leave the next cycle on the same position for
  ever when a whole page was another client's, and end every cycle after a
  single page when a few of each page were ours: the person's own settings
  behind a long run of foreign documents would never arrive. So
  `src/lib/rxdb/couch-fetch.ts` sends the plugin's `GET _changes` as
  `POST _changes?filter=_doc_ids` with `{doc_ids: [...]}`, the two settings and
  one `activity:<id>` per activity the app offers (`ownedDocIds()`, 57 ids,
  fixed, whatever the database holds). The gateway allows both
  (`couch_proxy_policy.py`: `filter` `_doc_ids`, a `doc_ids` body on
  `POST _changes`), `limit` stays at the plugin's 200 (the gateway's cap is
  1000), and a filtered feed still ends at the end of the database, so the
  checkpoint moves. Rows that are not ours are still dropped on the way in; if a
  server ever ignored the filter and a whole page came back foreign, that is a
  `502` (a failure the engine backs off on), not an empty feed that would stall
  silently. **Not verified against the live CouchDB**: that `POST _changes` with
  `filter=_doc_ids`, `include_docs` and `seq_interval` behaves as the fake in
  the tests (and as CouchDB's documentation says it does).
- **Defaults never win.** A device that did not change a setting writes nothing
  for it, and seeding after the first pull fills only ids that have no document
  at all. Conflicts: last writer wins by `updatedAt`, and the revision CouchDB
  chose on a tie. A delete is a revision like any other: the validator makes a
  tombstone carry `updatedAt` (and the other common fields), so a delete and an
  edit are ordered by their times, and an activity picked again here after
  another device removed it comes back, while a removal that came after the edit
  wins. RxDB's CouchDB plugin does not see a deleted document on the server as a
  conflict at all (its push check reads `_all_docs?include_docs=true`, which
  answers a deleted document with `doc: null`, and takes that for "nothing
  there"), so it would write over a deletion made elsewhere whatever the times
  say. `couch-fetch.ts` therefore reads the deleted revision back
  (`GET <id>?rev=<rev>`, which the gateway's policy allows) and puts it in the
  row, and the conflict rule is asked. A read that fails leaves the row as the
  server answered it, which is what the plugin would have had.
- **The local database opens at start, with no network and no credential.**
  It is purely on-device. When the browser already holds exactly one person's
  database (the id record above), the engine opens it first thing
  (`recordedPerson` in `couch-sync-start.ts`) and writes the person's changes to
  it as soon as the 750 ms debounce ends, offline too. Which person's? The one
  recorded; that is a guess until the credential says who is signed in, and if it
  was wrong (another person signed in on this browser) the engine closes that
  database, starts the right person's own, and writes what the person changed
  since the page started to it, **with the time they made it**. Until a
  credential has named the person, what is written to the guessed database is
  not durable: the time of the change and the record of it (next bullet) stay,
  so a wrong guess loses neither, and a page that closes before any credential
  still finds both. A browser with no database yet, or with several recorded,
  opens it when the first credential arrives, as before. A tab that is not the
  leader never gets a credential, so its database stays a guess: it reads no
  removal from it (a tombstone there may be the previous person's) and leaves
  the record to a tab, or a later page, that has one.
- **A change is never only in memory.** The moment a synced setting changes, the
  engine records (synchronously, in `localStorage` through `safe-storage`,
  `src/lib/rxdb/sync-pending.ts`, key `mukoko-sync-unwritten`) the state the
  person started from and when they changed it: a time and the three
  non-locational settings, no credential, no place, no name. The record is
  cleared once the change is in a document **of a database a credential has said
  is the person's**, and when a "signed out" is heard the second time; an engine
  clears only a record it wrote, so another tab's pending change is never
  forgotten. A
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
- **Only a real change by the person is a change.** The app's preferences bridge
  sets a FRESH array into the store on every emission of the preferences
  document (a place switch, a `/v1/devices` pull, another tab), so comparing
  `selectedActivities` by reference called each of those an edit: re-stamped with
  the current time (which beats a newer value from another device) and written
  to the record on every place switch. The store's subscription now compares the
  three settings **by value** (`src/lib/rxdb/sync-state.ts`, shared with the
  engine, which checks again), and says where a change came from:
  `"applied"` for a value set inside the preferences bridge's `applyToStore` (the
  hydration, a `/v1/devices` pull, another tab), `"person"` for everything else.
  An applied value is **not** the person's edit here: it becomes the baseline, is
  never written to the cloud as an edit with a new time, and, for a device-profile
  pull of a profile with no activities, is never read as the removal of every
  activity. The documents stay the truth: where one exists for a setting, the
  next apply brings the app back to it. While the person has a change of their
  own that is not written yet, an applied value cannot be told from it in one
  diff and rides along with it (known limit).
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
- **A missing document is not a removal.** An activity is dropped from the
  device only when the local database holds its TOMBSTONE (another device
  deleted it and the deletion was pulled). No document at all means this device
  has not seen it yet (a follower tab whose leader has not seeded, a first
  cycle, a database just created or wiped), and the activities a person chose
  before sync existed have no document until the leader's first cycle seeds
  them: reading "no document" as "removed" erased them on a follower tab.
- **Times are written in one form and compared as instants.** The validator
  requires every time this client writes to be exactly
  `YYYY-MM-DDTHH:mm:ss.SSSZ` (UTC, three fractional digits), and this client
  writes no other (a `createdAt` it keeps from an older document is rewritten in
  that form). It does not rely on the same of what it reads: conflicts
  (`updatedAt`) and the order of new activities (`createdAt`) are compared as
  instants, precision to the millisecond, so another form (an offset, more or
  fewer digits) decides nothing, and a time that cannot be read leaves the
  server's revision (a conflict) or sorts last (the order).
- **Only what this app offers, and what the validator allows, syncs.** The
  forecast models that sync are the validator's `forecastModel` enum (ten ids)
  intersected with what the My Weather picker offers (`ForecastModel` in
  `weather.ts`): `best_match`, `ecmwf_ifs`, `ecmwf_aifs025_single`,
  `gfs_seamless` and `icon_global` (`SYNCED_FORECAST_MODELS`; a test parses the
  enum out of the pinned validator and fails if the two differ, so a model added
  to either side is a decision). **`meteofrance_seamless`, which the picker
  offers, is not in the validator's enum**: a document for it is refused, and a
  refused document delays everything pushed with it, so that pick stays on the
  device: it is never written or seeded, and a document from another device
  never replaces it. **`apple_weatherkit` (Apple Weather, behind
  `FLAGS.apple_weatherkit`, off) is local-only for the same reason**: another
  provider's model, with no id in the validator's enum, so it joins
  `LOCAL_ONLY_FORECAST_MODELS` through `ForecastModel` whether or not the picker
  offers it. A model another client set that this app does not offer
  (`jma_gsm`, `ukmo_global_deterministic_10km`, `cma_grapes_global`, `gem_global`,
  `meteofrance_arpege_world`) is ignored and never replaces the person's own pick
  here; it does not stop this device's own edit of that setting from being
  pushed either (the push modifier lets the server's version through by shape).
  Every synced model is in the Worker's device-profile allowlist (the device
  profile, not CouchDB, carries a local-only pick: `apple_weatherkit` is in that
  allowlist too). Activities
  from another client are applied only if the app knows the id
  (`src/lib/activities.ts`, equal to the Worker's allowlist) and only up to 30,
  the device profile's limit, after the ones the person already holds; nothing
  they hold is dropped to make room. A document for an activity the app does not
  know is never requested (the pull lists the ids this client owns), so it
  neither reaches the device nor is applied. A document of another model
  version (`schemaVersion` outside `v3.x`) is not read.
- **A scheduled deletion of the account is terminal, and takes nothing.** A
  `403 account_pending_deletion` from the session route does not pass by itself,
  so the engine stops asking for the rest of the page's life (`failureAction`
  "stop_keep_data": status `account_closing`, no timer, no further request,
  however long the page stays open or whatever the person does), but unlike a
  sign-out it removes nothing: the person is signed in and the deletion can be
  cancelled. No local database is purged, no mark is left, the record of
  unwritten changes stays, and the person's changes keep being written to the
  local database (they are not pushed). A page restored from the back/forward
  cache asks once more. The same code on another status, or another 403, is an
  ordinary failure.
- **Every trigger waits for the back-off.** After a failure the engine waits
  (30 s doubling to 15 min) and nothing shortens it but the browser's own
  `online` event: a local write, another tab's write, the poll, a focus, a
  public `requestSync()` and the credential's renewal timer all leave the work
  pending and let the back-off timer run it, and a cycle that was already queued
  behind the one that failed does not run either. A failing service is asked
  once per wait, not once per edit; the edits are in the local database
  meanwhile (`couch-sync-backoff.test.ts`, on a manual clock).
- **The credential goes to the person's own database only.** The fetch layer
  parses every URL it is asked to send the bearer to: same origin (scheme, host
  and port), no user information, no backslash or `@`, no dot segment however it
  is written (`..`, `%2e%2e`, `.%2e`, a double-encoded one) and no encoded
  slash, and a normalised path that is the database's own or begins with it
  followed by `/` (so `user_abc2` is not under `user_abc`), or an exact extra URL
  (the personal route). A prefix test on the text was fooled by all of these
  (`couch-fetch.test.ts`).
- **Failures are silent and bounded.** A 401 from the session route that says
  `signed_out` means nobody is signed in: the engine goes idle until the next
  page load, with no failure count, no timer and no second request (see "Own
  database" for what it removes, and when). A 401 WITHOUT that code, like every
  other status from the route, is a failure to retry: it removes nothing. 401 from the
  database means fetch a new credential once, then back off; 403 (but for the
  scheduled-deletion one, above), 404, 429, 5xx,
  offline and timeouts back off 30 s doubling to 15 min and the app stays
  local-only (`src/lib/rxdb/couch-sync.ts`, `couch-schedule.ts`). A credential
  with under 75 s left when it arrives is a failure too, and two credential
  fetches are never closer than 5 s (`src/lib/couch-session-timing.ts`), so a
  short-lived grant cannot make a loop. **The credential's life is counted on
  the device's own clock.** The route sends a duration, `expiresIn` seconds
  counted by the server from when it issued the grant, never a time of day, and
  the engine ends the credential that long after the moment it SENT the request
  (the grant was issued some time between, so this is never later than the
  truth). A server time compared with the device clock was wrong by however far
  the two differ: a device 4 minutes fast saw every fresh five-minute grant as
  too short (a silent loop to a 15-minute back-off) and a slow one kept using an
  ended one. Nothing waits for ever: the credential
  request ends at 25 s, opening the local database at 10 s (a database that
  opens later is closed again), a replication at 60 s, winding a replication down
  and closing the database at 5 s each (below), and each request of a
  replication, **body included**, at 25 s (`requestWithin`, the one place a
  request, its timeout and its abort are put together; the session client uses it
  too). A replication that fails after its pull still applies what it pulled, so
  a push that keeps failing does not keep the person's other devices' changes off
  this one.
- **One RxDB internal, pinned.** The plugin retries a failed request for ever,
  and `cancel()` and `pause()` queue behind a start that, for a non-live
  replication, only ends when the first sync does. There is no public way to end
  a failing cycle, so `endReplicationRetries` (`couch-rxdb.ts`) flags the
  replication as paused through `state.internalReplicationState.events.paused`,
  which the plugin's own retry loops read. `couch-rxdb-internals.test.ts` pins
  the RxDB version it was checked against (17.3.0), the shape, and the behaviour
  (with a control showing the plain `cancel()` does not settle), and fails with a
  message saying what to re-check on an upgrade. If an upgrade breaks it anyway,
  a cycle still cannot hang: the wait for `cancel()` is bounded (5 s), the
  replication is then abandoned (its requests are aborted, so it sends nothing),
  no second replication of the same identifier is started beside it (later cycles
  fail at once as "no answer" and the engine backs off; the page keeps working on
  the local database until it is reloaded), and closing the database is bounded
  too.
- **Teardown.** `pagehide` stops the engine: it first abandons what the cycle
  is waiting on (the replication and its requests, a credential request, the
  opening of the database), then writes the pending change, then closes
  the database; the cycle ends at its next step and does not seed, apply or
  replicate again. The pending change goes through its own lock, never behind the
  cycle, so it is not held up by a replication that can last a minute (the write
  debounce and `flush()` likewise); the record in web storage already holds it
  and stays if the write fails. A page restored from the back/forward cache
  starts again, and a cycle of the earlier run that is still ending does not run
  beside the new one. A hidden page writes its pending change at once
  (`visibilitychange`).
- **The document shape is the validator's, and the validator is data-infra's
  generated one.** nyuchi-api installs `gateway/lib/couch_validate_personal.js`
  (generated in nyuchi/data-infra from `schemas/model/userdb.yaml`, ADR-0002) as
  `_design/user` in every person's database (`POST /v1/couch/personal`). A
  verbatim copy is pinned in `src/lib/rxdb/__fixtures__/` (see "The validator the
  documents are judged by" below) and the tests EXECUTE it on every document the
  client writes. What it requires, and so what `couch-docs.ts` builds:
  - **every document**: `_id`, `schemaVersion` (a string `^v[0-9]+\.[0-9]+$`; this
    client writes `v3.1`), `type` (the part of `_id` before the colon),
    `deviceId` (a lower-case UUID: the install that wrote it), `createdAt` and
    `updatedAt` (exactly `YYYY-MM-DDTHH:mm:ss.SSSZ`), and **no other field**
    (`additionalProperties: false`). There is **no `ownerPersonId`**: the
    database name is the ownership (the function refuses a write whose database
    is not `user_<the signed-in person>`). `updatedAt` may not be more than a day
    ahead of the SERVER's clock (see "Known limits");
  - **a setting** (`preference:<key>`): plaintext `preferenceKey` equal to the key
    in `_id` and a string `preferenceValue` with the key's rule (`theme` is
    `light`, `dark` or `system`; `forecastModel` one of ten ids), no envelope;
  - **an activity** (`activity:<id>`): `activityId` equal to the id in `_id`;
  - **a deletion**: `_deleted: true` WITH the common fields (`type`,
    `schemaVersion`, `deviceId`, `createdAt`, `updatedAt`) and nothing else: no
    `activityId`, no `preferenceKey`, no `preferenceValue`, no envelope. A bare
    `{_id, _rev, _deleted}` is refused as an unknown document type. The tombstone
    carries the time and the install of the deletion
    (`SyncStore.tombstone(id, nowMs, deviceId)`).
    The earlier pin was the validator of nyuchi-api v0.51.0 (an integer
    `schemaVersion`, an `ownerPersonId`, stub tombstones): wrong, and replaced
    (nyuchi-api #468/#472, commit a665d20a1, 2026-11-02, in v0.53.0 and on `main`).
    A write the validator refuses delays everything pushed with it, so nothing is
    written that the pinned validator does not accept: `assertPlaintextDoc` is the
    gate in `upsert`, the planners build only accepted documents, and a value the
    model does not allow stays on the device. The `deviceId` is the app's own
    device id when that is a lower-case UUID, else one of the sync's own
    (`sync-install-id.ts`, kept in web storage and reused); an engine given anything
    else does not start. The other five types of the model (`savedPlace`,
    `interest`, `engagementEvent`, `historyEntry`, `deviceNote`) and
    `preference:homePlace` need an envelope and are not written from here.

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
page: { token, expiresIn, database, apiOrigin } --> POST {api}/v1/couch/personal  (once per run)
                                                --> replication on {api}/v1/couch/db/user_<personId>/
```

The grant is the bearer for replication and only that: the gateway accepts it
on `/v1/couch/db/user_<own id>/...` and `POST /v1/couch/personal` and nowhere
else (`POST /v1/couch/session` and every other route refuse it). A full sign-in
token never reaches page JavaScript, and the browser never sees the WorkOS
token or the key.

### Read in nyuchi-api `staging` (2026-11-03, after v0.53.0; none of it run)

These are facts about the gateway's exchange, read in its source. They were not
run against the live gateway, and nothing here has been observed on a wire.

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

### The validator the documents are judged by

`src/lib/rxdb/__fixtures__/couch_validate_personal.fn.txt` is a **pinned copy,
not edited**, of nyuchi-api `gateway/lib/couch_validate_personal.js`, the
`validate_doc_update` that `POST /v1/couch/personal` installs as `_design/user`
in every person's database. A header names where it came from, and the sidecar
`couch_validate_personal.source.json` holds the same facts for the tests:

- **source**: `nyuchi/nyuchi-api`, branch `staging`, commit
  `a665d20a1d9452fc39ba70d29f61f35762b74f48` (2026-11-02, "re-sync the
  private-database rules to data-infra#163"), the last commit that touched the
  file. v0.53.0 and `main` have the same file. Staging's head when it was read
  was `3ea461dfef2af2551440ed20efd6bbb3b74fb2c3`;
- **read on 2026-11-03**; git blob `13807551ca1f0ac1671c72837a7611db89b7b3ad`,
  sha-256 `1128ab258c911eb890eaa7f86654fe55ae866983d74b0e0b0082351dc1a222cc`
  (the value nyuchi-api's own `couch_validate_personal.source.json` pins);
- **origin**: generated in nyuchi/data-infra from `schemas/model/userdb.yaml`
  (data-infra commit `ace188646db7b5c515595d92a4e97f4a7d2996ae`).

`couch-validator-pin.test.ts` hashes everything under the marker line in the
fixture and fails if it is not the file the sidecar names (so a hand edit shows),
and `test-support/couch-validator-facts.ts` runs the function as CouchDB would
(`newDoc`, `userCtx` with the database name, the server's clock injectable). The
tests execute it on every document the client writes: live documents,
tombstones, every setting it syncs (each theme, each synced model) and every
activity the app offers, directly and through the real plugin in
`couch-rxdb.test.ts` and `couch-sync-e2e.test.ts`. The forecast-model and theme
lists are parsed out of it, not retyped.

What this does NOT show: that the live database has this function installed
(nothing here has run against a live CouchDB or the live gateway), or that the
gateway has not changed since the day it was read. The function's own header
comment says "PROPOSED: nothing installs this on a live CouchDB", which is stale
(`gateway/lib/couch_documents.py` installs it); it is kept verbatim.

#### Re-pinning the validator

**Rule: re-pin this fixture whenever nyuchi-api's couch_validate_personal.js
changes** (and read the diff first: a changed rule is a change of what this
client may write). The steps:

```sh
curl -H 'Accept: application/vnd.github.raw' 'https://api.github.com/repos/nyuchi/nyuchi-api/contents/gateway/lib/couch_validate_personal.js?ref=staging' > body.js
```

(add `-H "Authorization: Bearer $GH_TOKEN"` if the repository needs it). Write the
fixture's header, the marker line and `body.js` into
`src/lib/rxdb/__fixtures__/couch_validate_personal.fn.txt`, update the sidecar
(`lastChangeCommit`, `lastChangeDate`, `blobSha`, `sha256`, `readOn`) and this
section, then run the tests and let them say what moved: a new `forecastModel`
value or a stricter rule fails a test with the document that no longer passes.

#### Follow-ups in other repos

- `meteofrance_seamless`, which the My Weather picker offers, is missing from
  data-infra's `forecastModel` enum (propose adding it); until then that pick
  stays on the device.
- The Worker's device-profile list (`FORECAST_MODELS` in
  `weather_core::community`, 12 ids) and the validator's enum (10 ids) are two
  different lists: the Worker has `apple_weatherkit`, `ecmwf_ifs025`,
  `ecmwf_ifs04`, `icon_seamless` and `meteofrance_seamless` that the validator
  lacks; the validator has
  `ukmo_global_deterministic_10km`, `cma_grapes_global` and `jma_gsm` that the
  Worker lacks. `couch-docs.test.ts` pins the difference so a change on either
  side is noticed. What syncs is the intersection with what the app offers.

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
- **401 means signed out, and one 401 removes nothing.** The page answers a 401
  from the session route by (eventually) removing its local copy of the person's
  settings and its record of unwritten changes, which may hold the only copy of a
  change made offline, and a removal cannot be undone. So:
  1. The route gives exactly one 401, for a request with **no AuthKit session
     cookie at all**, with the body `{"error": "signed_out"}` (`SIGNED_OUT_CODE`,
     `src/lib/couch-session-contract.ts`; ahead of the configuration check and
     the limiter). `withAuth()` also gives no user when AuthKit's refresh of the
     access token FAILS while the sealed cookie is intact (its catch block in
     `@workos-inc/authkit-nextjs` `session.js` `updateSession`: a WorkOS outage,
     or a single-use refresh token that a concurrent request used first), so a
     missing user alone proves nothing: **a session cookie with no user is
     `503 couch_unavailable`** (`hasSessionCookie`, `src/lib/api-route-guards.ts`,
     which follows `WORKOS_COOKIE_NAME` as AuthKit does).
  2. The page treats ONLY a 401 carrying that code as signed out, and even then
     **the first one only idles and leaves a mark** (the time, in web storage,
     `sync-signed-out.ts`): nothing is removed, and the record of unwritten
     changes stays, so a blip costs nothing. The local copy is removed when a
     LATER page load hears it again, at least a minute (`SIGNED_OUT_CONFIRM_MS`)
     after the first (a reload or a second tab a moment later is the same
     observation, and the mark keeps its first time). Any session that is issued
     removes the mark. A tab left open after a real sign-out therefore keeps the
     person's non-locational settings in IndexedDB until the next page load of
     the site by anyone, or until another person signs in on this browser (their
     credential removes the previous person's database at once, which is
     certain). That is the cost of never removing on a doubt.
  3. Whatever the WorkOS token or the gateway say about a person who IS signed
     in is a retry-later `503 couch_unavailable`: an access token that is
     missing or has ended (AuthKit's refresh failing for a moment, WorkOS
     answering 5xx), and the gateway refusing the exchange (`invalid_grant`: a
     revoked or skewed token, a WorkOS client mismatch, an operator
     misconfiguration). A session that really ended is the no-user 401, which
     comes first and never reaches the gateway. (The exchange error mapping of
     `/api/app-keys`, a different route with different stakes, is unchanged.)

  The route checks that sync is set up
  here (`NYUCHI_API_URL`, the app's key, `WORKOS_CLIENT_ID`) before it spends
  the person's hourly allowance, so an unconfigured site answers 503 without a
  Mongo write. The route's address is defined once, in
  `src/lib/couch-session-timing.ts` (`COUCH_SESSION_PATH`), which the page's
  client and the proxy import; a test pins it to the folder the route lives in
  and to there being no second spelling. The database name rule and the
  signed-out code live in `couch-session-contract.ts`, which imports nothing,
  so the server's issuer and route do not import the sync engine's modules.

- **The answer is a duration.** `{ token, expiresIn, database, apiOrigin }`:
  `expiresIn` is whole seconds from the moment the server issued the grant,
  counted on the server's clock and rounded down (`expiresInSeconds` of the
  issuer; a grant with under a second left is refused). The page never reads a
  time of day from the server (see "The credential's life is counted on the
  device's own clock"). The grant's own `exp` stays a server-side check.
- **Errors.** Nobody signed in is `401 signed_out`; a scheduled
  deletion is `403 account_pending_deletion` (the only wire difference from an
  ended session is the gateway's sentence, so the match is a convenience: if the
  text changes the person gets a retry-later 503, which is safe; the page stops
  asking for the life of the tab and removes nothing, above); `429` keeps
  the gateway's `Retry-After`; everything else (the client not on the allow-list,
  an unconfigured key, a refused exchange, a 5xx, a timeout, an unreadable
  answer, no linked person) is `503 couch_unavailable`, which the page backs off
  on.
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
  `/api/app-keys` uses it too, so the per-person limit does not protect it: sync
  traffic could use up the minute and break developer-key management for people
  who never turned sync on. **The sync route therefore spends from a site-wide
  budget of its own** (`src/lib/couch-session-budget.ts`; one counter,
  `couch-session-global:user:all:<window>`, in the same Mongo collection and with
  the same limiter as the per-person ones; `/api/app-keys` counts under
  `app-keys-<action>:user:<id>`, so neither can take from the other): **6
  exchanges every 20 seconds**. Sustained that is 18 a minute; a fixed window can
  pass its whole limit at its very end and again at the start of the next, so any
  60 seconds overlap at most four windows, 4 x 6 = 24, and at least 6 of the 30
  are always left to `/api/app-keys` (a single 60-second window of 18 would allow
  36 across a boundary, over the gateway's 30). The order in the route is the
  session, the configuration, the issuer's local checks (`precheck`: an access
  token that is missing, ended or too short to make a grant from is a `503` that
  costs nothing, because retrying at once cannot cure it), the person's own
  limit, the site's budget, and only then the exchange; a refused request spends
  no exchange and answers `429` with `Retry-After`, which the page backs off on. If the gateway answers `429`
  anyway (the key's ceiling was reached by something this budget does not see),
  the route notes it, logs it once (no person in the line), and that instance
  sends no more sync exchanges for the time the gateway named, at most 30 s; this
  also holds when Mongo is down, where the counter fails open like the
  per-person one (abuse protection must not take sync down). The budget is
  therefore room for roughly 72 visible tabs syncing at once (18 a minute at one
  renewal per tab every four minutes; only a browser's leader tab asks, so in
  practice 72 browsers; the number is `SUPPORTED_VISIBLE_TABS` in
  `couch-session-budget.ts`, and a test fails if this page or CONTRIBUTING.md
  says another); beyond it the page backs off and nothing breaks. So a wide rollout of the flag still needs a gateway decision about this
  key's ceiling, which is not made here. (The counter is one hot document under
  heavy load; accepted for now, since the requests it limits are few.)
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
gateway's request allow-list and runs the pinned `validate_doc_update` (a copy
of the file nyuchi-api ships, read from `staging` on 2026-11-03; see "The
validator the documents are judged by"). Nothing was sent to any production
endpoint. **The wire format is judged by that copy and by nothing live**: that
the installed `_design/user` is that function, and that the gateway's file has
not changed since it was read, are not known. Only a live run can show: the real gateway
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
- **`POST _changes?filter=_doc_ids` on the real CouchDB and gateway**, and that
  abandoning a replication (`AbortController` on its requests, RxDB's own
  cancel) leaves RxDB's replication state clean in a real browser. The fake
  CouchDB ports the gateway's policy and CouchDB's documented behaviour of the
  filter (including a `last_seq` that moves to the end of the feed when nothing
  matched), not the server.
- **The activities and models other clients write.** The mobile app's own
  documents are only simulated (schema-valid documents of the model's other
  types, with an envelope the validator checks for form); whether it writes the
  activity and forecast-model documents of this client's types with the shapes
  assumed here has not been seen.
- **Reading a deleted document back (`GET <id>?rev=<rev>`)** so that a deletion
  made on another device is ordered against a local edit (see "Defaults never
  win"). The gateway's policy allows it (read in `couch_proxy_policy.py`), and
  CouchDB returns the body of a deleted revision, but this has only been run
  against the in-memory fake; if the real answer differs the row stays as the
  plugin would have had it (a local edit then writes over a remote deletion).
- **AuthKit's behaviour behind "a session cookie with no user".** Read from the
  installed `@workos-inc/authkit-nextjs` 4.4.0 (`session.js`, `updateSession`
  and `withAuth`): a failed refresh returns `{ user: null }`, and a transient
  one keeps the sealed cookie. Not run against WorkOS. What a cookie AuthKit
  cannot unseal at all (`WORKOS_COOKIE_PASSWORD` rotated) does was not read to
  the end: if it also ends as "a cookie with no user", the answer is a 503 for as
  long as the cookie is there and the local copy is not removed by it; it goes
  when another person signs in, or once the cookie is gone.
- **Aborting an in-flight replication and the pinned RxDB internal in a real
  browser.** The tests run the real plugin on memory storage; they pin the
  internal against the installed version and show the bounded wait, not what a
  browser does with a write begun during `pagehide`.

## Known limits, and what was left for later

- **Conflicts are decided by device clocks.** Last writer wins by the
  `updatedAt` each device stamped; a device whose clock is far ahead wins
  conflicts. The server never issues a time for a document, so there is nothing
  better to compare. (The credential's life, which the server DOES issue, is
  counted without the device clock: above.)
- **A device clock more than a day ahead is refused, not just ahead.** The
  validator rejects an `updatedAt` more than 24 hours ahead of the SERVER's clock
  ("updatedAt is too far ahead"), so every write of such a device is refused, and
  a refused write fails the cycle and backs off (it never loops). Nothing here
  detects or repairs a clock like that; the person's changes stay in the local
  database.
- **The picks the validator cannot hold stay local.** `meteofrance_seamless` and
  `apple_weatherkit` (above) are not synced; each is the person's pick on this
  device only.
- **Anonymous visitors, with the flag on, download the engine and make one
  `POST /api/couch/session` per page load (a guaranteed 401).** Real, and
  irrelevant while the flag is off. Before widening the flag: a signed-in hint
  so anonymous visitors never load the engine or call the route.
- **`POST /v1/couch/personal` runs once per page load (the leader tab).** It is
  idempotent and the gateway limits it to 30 a minute per IP, and a 404 from the
  database prepares it again anyway, so remembering "prepared" for a day would
  be safe; not done.
- **A tab that is not the leader never confirms whose database it has open**
  (it asks for no credential), so it applies no removals and leaves the record
  of unwritten changes to a tab or a page that has a credential.
- **After a `404` and a new `POST /v1/couch/personal`, the replication
  checkpoint is not reset**, so documents already pushed to the old database are
  not pushed again to the new one until they change. Nothing local is lost.

## Next slice

`savedPlace`, `preference:homePlace`, `interest`, `engagementEvent`,
`historyEntry` and `deviceNote` as JWE envelopes (`alg: dir`, `A256GCM`, `aad`
the base64url of the `_id`). Open: where the device key lives and how a second
device gets it; recommended, not decided, a non-extractable WebCrypto key in
IndexedDB wrapped by a passphrase- or passkey-derived key, with a short ADR in
data-infra first. (The pinned validator accepts those types and checks the
envelope's form and its `aad`, which must name the document's `_id`; it cannot
tell whether the ciphertext is one.)
