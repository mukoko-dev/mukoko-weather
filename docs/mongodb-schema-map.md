# Nyuchi Platform — MongoDB Schema Map

**Cluster:** `nyuchi-platform-doc-db.ge8d8qi.mongodb.net`
**Total size:** 74 MB across 27 databases (excluding `admin`/`local`)
**Doctrine:** Bundu / Ubuntu federated platform. Mukoko Weather is **one app** plugged into this shared platform.

This document maps the platform so we know what mukoko-weather should **consume** vs. what it should **own**.

---

## Strategic context — Nyuchi StationKit

**Nyuchi StationKit** is the engine for building out a network of physical weather stations across Africa to deliver more accurate, ground-truth weather data than any commercial API. This is mukoko-weather's long-term moat.

The platform already has the data model ready:

- **`weather.stations`** — physical station registry with sensor lists, QC ratings, calibration tracking, ownership (entityId), location, and firmware versions
- **`weather.stationObservations`** — raw payloads as they come off the wire
- **`weather.observations`** — QC-validated observations (after pipeline processing)
- **`device.devices` (category=weather_station)** — the same hardware viewed as a device for fleet management (firmware updates, calibration commands, telemetry)
- **`device.commands` (calibration_request)** — calibration orchestration
- **`device.telemetry` (sensor_reading_summary, calibration_status)** — station health monitoring

The integration loop:

```
StationKit hardware  →  device.devices (registration)
       ↓                ↓
   raw readings      heartbeats / telemetry
       ↓                ↓
weather.stationObservations  → QC pipeline → weather.observations
                                                      ↓
                              Mukoko app:  shown as ground-truth overlay
                                           feeds AI Shamwari for better summaries
                                           cross-validates community reports
                                           future: trains hyperlocal nowcast ML
```

This is **why** we're rebuilding on the new schema — to plug straight into StationKit when the first stations come online. We're not dumping; we're rebuilding the mukoko-weather app to be a proper StationKit consumer + commercial-API fallback.

---

## TL;DR — what changes for mukoko-weather

| Concern                                         | Old approach                                                                                                                                                                                                           | New approach                                                                                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Users / auth**                                | Anonymous device UUIDs                                                                                                                                                                                                 | `identity.persons` collection (OIDC-compliant; already supports `workosUserId`)                                                                |
| **Locations**                                   | ~~`weather.locations`~~ (dropped Phase 0F) — clean URL slugs resolve through `places.placesGeo` via `src/lib/places.ts`; static `LOCATIONS` array kept only as a slug→display-metadata fallback (not a DB seed source) | `places.places` (POIs) + `places.placesGeo` (admin geography)                                                                                  |
| **Device sync**                                 | Local `device_profiles` keyed by random UUID                                                                                                                                                                           | `device.devices` with `userDevice` sub-document, `associatedUsers`, content filter profiles, `mukokoAppVersion` already in `softwareInventory` |
| **AI / Shamwari**                               | `ai_summaries`, `ai_prompts`, `ai_suggested_rules` in app-local DB                                                                                                                                                     | `shamwari.conversations` + `shamwari.messages` + `shamwari.guardrails` + `shamwari.knowledgeBase` (vector-embedded) + `shamwari.preferences`   |
| **Severe weather alerts**                       | Not implemented                                                                                                                                                                                                        | `weather.alerts` (already exists, **CAP-format**)                                                                                              |
| **Weather stations**                            | Not implemented                                                                                                                                                                                                        | `weather.stations` + `weather.observations` (Bundu hardware integration ready)                                                                 |
| **Provider keys** (Tomorrow.io, MapTiler, etc.) | `api_keys` collection in app DB                                                                                                                                                                                        | `integrations.providerConfigurations` with secrets refs                                                                                        |
| **Community reports**                           | `weather_reports` (snake_case, simple)                                                                                                                                                                                 | `weather.communityReports` (camelCase, schema-validated, with image URLs, `reporterPersonId` → identity)                                       |
| **Audit / activity**                            | Not tracked                                                                                                                                                                                                            | `identity.activityLog` + `device.deviceHistory` (full event stream)                                                                            |

The local `mukoko-weather` MongoDB is essentially **deprecated**. Mukoko is now a **client** of the shared platform.

---

## The 27 databases

### Core platform databases (Mukoko depends on)

#### `identity` — Auth + person profiles (P0 dependency)

OIDC-compliant. Already supports WorkOS + Stytch. **This is where mukoko's users live.**

| Collection     | Purpose                                                                 | Notes for mukoko                                                                                                                                                                                                                         |
| -------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `persons`      | Canonical user records. `_id` is UUID used as OIDC `sub` claim.         | Has `workosUserId`, `stytchUserId`, `preferredLanguages`, `bundu.familyMembership`, `bundu.verificationTier` (0-3). On WorkOS sign-in, upsert by `workosUserId`. **Phase 1a — wired up via `src/lib/auth.ts → upsertPlatformPerson()`.** |
| `credentials`  | Per-person credentials (password, passkey, WebAuthn, OAuth, TOTP, etc.) | `provider: "workos"` is a first-class supported value. Phase 1a writes a `(workos, oauth_token)` credential per person on sign-in, deduped on `(personId, provider, credentialType)`.                                                    |
| `activityLog`  | Audit trail of signup/signin/MFA/credential events                      | Mukoko writes `{eventType: "signin"                                                                                                                                                                                                      | "signup", source: "api", surfaceContext: "mukoko-weather", provider: "workos", success: true}` on every WorkOS callback (Phase 1a). |
| `personSkills` | Skills + ISCO-08 codes per person                                       | Not relevant to mukoko unless integrating activities → skills.                                                                                                                                                                           |

##### Mukoko auth flow (Phase 1a)

```
Browser → /auth/signin → getSignInUrl() → WorkOS hosted sign-in
                                                ↓
                       /callback ← OAuth code ←
                          │
                          ├─ handleAuth() (AuthKit) sets the session cookie
                          └─ onSuccess(user) → upsertPlatformPerson(user)
                                                      │
                                ┌─────────────────────┼─────────────────────┐
                                ▼                     ▼                     ▼
                       identity.persons     identity.credentials   identity.activityLog
                      (dedup by workosUserId    (dedup by             (append-only,
                       → email → insert)        personId+provider+    eventType=signup
                                                credentialType)        on first; signin
                                                                       on subsequent)
```

The implementation lives in `src/lib/auth.ts`. Dedup is enforced in code (Phase 0E lesson) — `upsertPlatformPerson` never creates a second persons doc for the same WorkOS user, and never creates a second `(workos, oauth_token)` credential for the same person. See `CLAUDE.md` → "Authentication" for the full breakdown.

#### `places` — Locations / geography (P0 dependency, replaces our `locations`)

Far richer than our local `LOCATIONS`. Includes conservation, hospitality, commerce, accessibility, content completeness, ubuntu trust signals.

| Collection                         | Purpose                                                                                                                                                                                                                                                                                                   | Notes for mukoko                                                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `places`                           | Every place — landmarks, businesses, parks, mountains, lakes, towns. Schema.org-aligned (`LocalBusiness`, `TouristAttraction`, `Park`, etc.) Includes `conservation.bigFive`, `hospitality`, `commerce`, `bundu.trustSignals`, `bundu.communityCaretakers`.                                               | Mukoko reads from this. **Stop maintaining `src/lib/locations.ts` seed array.** Add a Python helper `place_by_slug()` that reads from `places.places`. |
| `placesGeo`                        | Administrative geography (continent → country → province → city → town → village). ISO 3166 codes. 2dsphere-indexed boundaries. `sourceProvenance.dataOrigin` enum includes `mukoko_seed` (Phase 0C-1 city seed) and `mukoko_user` (Phase 0E — written from `add_location` when a user adds a new place). | Use for breadcrumbs (Country / Province / Location). Replaces our hardcoded `COUNTRIES`/`PROVINCES`.                                                   |
| `seedRequests`                     | **NEW (Phase 0E)** — validatorless queue of Fundi Places seed requests. Mukoko writes one entry per search-miss; the Fundi worker polls and processes them. See "Search-miss flow" section below.                                                                                                         | Mukoko writes only. Fundi consumes.                                                                                                                    |
| `categories`                       | OSM-tagged categories with translations + schema.org type mappings                                                                                                                                                                                                                                        | Could replace our `TAGS` system.                                                                                                                       |
| `seasonalInfo`                     | RRule-based seasonal patterns per place (closed seasons, harvest, migration)                                                                                                                                                                                                                              | Mukoko's `seasons` collection should reference these.                                                                                                  |
| `routes`                           | Hiking/cycling/driving routes (GeoJSON LineString)                                                                                                                                                                                                                                                        | Future: integrate with activity insights ("good day for the {route name} cycle").                                                                      |
| `conditionReports`                 | Community condition reports per place (accessible/closed/hazard/etc.)                                                                                                                                                                                                                                     | Sibling concept to weather reports. Can cross-link.                                                                                                    |
| `placeSnapshots`, `routeSnapshots` | Versioned history                                                                                                                                                                                                                                                                                         | Read-only audit.                                                                                                                                       |

#### `weather` — Weather domain (Mukoko's primary home)

Mukoko owns most of this but **must adopt the new schemas** (`_schemaVersion`, `bundu` sub-doc, camelCase, validators).

| Collection                                                                                                           | Mukoko's old equivalent        | Migration needed?                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stations`                                                                                                           | (didn't have it)               | **NEW** — Bundu hardware weather stations. Owned by entities. Sensors, QC ratings, firmware.                                                                                                                                                                            |
| `observations`                                                                                                       | (didn't have it)               | **NEW** — Validated/QC'd observations from stations or model outputs. Replaces parts of `weather_cache`.                                                                                                                                                                |
| `stationObservations`                                                                                                | (didn't have it)               | **NEW** — Raw station payloads.                                                                                                                                                                                                                                         |
| `alerts`                                                                                                             | (didn't have it)               | **NEW — P0 GAP NOW FILLED**. CAP-format severe weather alerts with `severity`, `urgency`, `certainty`, `area.polygon`. **Mukoko should consume + push-notify.**                                                                                                         |
| `weather_cache`                                                                                                      | `weather_cache`                | Same name, but new schema. Migrate forward.                                                                                                                                                                                                                             |
| `ai_summaries`                                                                                                       | `ai_summaries`                 | Stays in `weather` DB (mukoko-specific). **Phase 1D:** the write-side endpoint (`/api/py/ai`) is only reachable through the auth-gated Next.js proxy `/api/ai/*` — every cache fill happens for a signed-in WorkOS user, and `X-Mukoko-User-Id` is forwarded for audit. |
| `history_analysis`                                                                                                   | `history_analysis`             | Stays.                                                                                                                                                                                                                                                                  |
| `weather_history`                                                                                                    | `weather_history`              | Stays.                                                                                                                                                                                                                                                                  |
| `communityReports`                                                                                                   | `weather_reports` (snake_case) | **RENAME + RESCHEMA.** Now camelCase, includes `imageUrls`, `reporterPersonId` (→ identity), `qcStatus`.                                                                                                                                                                |
| `activities`, `activity_categories`, `suitability_rules`, `ai_prompts`, `ai_suggested_rules`, `seasons`, `locations` | Same                           | Existing; need to adopt `_schemaVersion` + `bundu` patterns.                                                                                                                                                                                                            |

#### `shamwari` — AI / chatbot (replaces our local AI tables)

Our `ai_summaries` + `ai_prompts` + `ai_suggested_rules` in `weather` DB stay (mukoko-specific). But **conversations** move here.

| Collection      | Purpose                                                                                                                                | Notes                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `conversations` | Per-user chat sessions. `surfaceContext: "mukoko-weather"` namespaces mukoko chats. Stores model provider/version, system prompt hash. | Replaces our ephemeral `ShamwariContext`.                                              |
| `messages`      | Anthropic content-block format. `conversationId`, `role`, `sequence`, token counts.                                                    | Persists chat history. Allows resuming.                                                |
| `toolUsage`     | MCP tool call audit log.                                                                                                               | Tracks every tool call (search, get_weather, etc.) — useful for debugging + analytics. |
| `guardrails`    | Cross-app guardrails. `isCore: true` cannot be disabled. Has `mukoko` sub-doc for app-specific overrides.                              | We pull these into the AI system prompt.                                               |
| `knowledgeBase` | Vector-embedded knowledge resources (RAG). `embedding` array for Atlas Vector Search.                                                  | Future: index our weather expertise here for retrieval.                                |
| `preferences`   | Per-person Shamwari preferences.                                                                                                       | Replaces our local activity prefs.                                                     |

#### `device` — Device registry (Bundu fleet)

This is huge — covers user devices, weather stations, kiosks, datacentre nodes.

| Collection                                               | Purpose                                                                                                | Notes for mukoko                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `devices`                                                | Every device on the platform. Has `category: "user_device"                                             | "weather_station"                                                        | "kiosk" | "datacentre_node"`. `userDevice.associatedUsers[]`links to people. Tracks`mukokoAppVersion`in`softwareInventory`. **Built-in content filter profile** with strict/moderate/permissive categories. | Mukoko mobile app (Expo) registers here. Weather stations register too. |
| `commands`                                               | Async commands sent to devices (revoke_trust, wipe_local_state, force_sync, calibration_request, etc.) | Mukoko native app should poll for these.                                 |
| `telemetry`                                              | Health/heartbeat/sync outcomes/crash reports per device                                                | Mukoko crash reports go here.                                            |
| `deviceHistory`                                          | State transition audit log                                                                             | Read-only.                                                               |
| `device_profiles`                                        | Legacy collection (no validator)                                                                       | Our current cross-device sync writes here. Migrate forward to `devices`. |
| `firmware`, `pairings`, `sessions`, `managementPolicies` | Bundu hardware management                                                                              | Not directly used by mukoko web/mobile yet.                              |

#### `integrations` — Third-party provider registry (P1 dependency)

Replaces our `api_keys` MongoDB collection.

| Collection               | Purpose                                                                                                                                                           | Notes                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `providers`              | Catalog of every external provider (WorkOS, Tomorrow.io, MapTiler, Anthropic, etc.). Tracks `category`, `providerType`, `license`, `bundu.sovereigntyAssessment`. | Read-only for mukoko.                                    |
| `providerConfigurations` | Per-environment/per-country configs with `credentialsReference` (secret-store pointer). Has `appliesToCountryCodes` for region-specific instances.                | Mukoko calls these to know how to talk to each provider. |
| `standards`              | Adopted standards (BCP 47, schema.org, ActivityPub, OGC, etc.) with `bundu.isFoundational`.                                                                       | Read-only documentation.                                 |

### Other databases (not Mukoko's concern unless cross-app feature)

| DB            | What it likely is                                                          | Mukoko interest?                                                           |
| ------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `bytes`       | Bytes (the social / posts app)                                             | No                                                                         |
| `campfire`    | Campfire — group conversations                                             | No                                                                         |
| `circles`     | Circles — social graph                                                     | No                                                                         |
| `commerce`    | Commerce app — payments, products, orders                                  | Possible: monetisation tier                                                |
| `engagement`  | Cross-app engagement tracking                                              | Yes (later): mukoko interactions feed `places.discovery.viewCount` rollups |
| `entity`      | Entities (organisations, families, communities) — owners of devices/places | Yes: every place + device has `ownerEntityId`                              |
| `events`      | Events / activities (concerts, gatherings)                                 | No                                                                         |
| `health`      | Health domain                                                              | Future: malaria/dengue risk integration                                    |
| `hospitality` | Hotels, restaurants, accommodation                                         | No (now folded into `places.places.hospitality`)                           |
| `jobs`        | Async job queue                                                            | Yes: long-running tasks (DB init, etc.)                                    |
| `knowledge`   | Cross-app knowledge graph                                                  | Yes: future RAG sources                                                    |
| `lingo`       | Localisation / translations                                                | **Yes — P1**: replace our `src/lib/i18n.ts`                                |
| `logistics`   | Logistics app                                                              | No                                                                         |
| `news`        | News app (65MB — biggest DB)                                               | No                                                                         |
| `novels`      | Novels app                                                                 | No                                                                         |
| `planner`     | Trip / event planner                                                       | Future: weather forecast integration                                       |
| `platform`    | Core platform metadata (feature flags, versions, etc.)                     | Yes: feature flags?                                                        |
| `pulse`       | System health / status                                                     | Yes: status page should consume from here                                  |
| `suggestions` | Suggested prompts / actions cross-app                                      | Maybe                                                                      |
| `transport`   | Transport / public-transit app                                             | No                                                                         |
| `ubuntu`      | Bundu doctrine / philosophy content                                        | Yes: pull doctrine content into mukoko's About page                        |

---

## Schema conventions (universal to the platform)

Every collection (except `device_profiles` legacy) uses these patterns:

1. **`_id` is a string** (UUID-like), not ObjectId
2. **`_schemaVersion: "v3.1"`** — required field, enum-validated. Some collections use `"v3.2"`.
3. **`bundu` sub-document** — platform-specific extensions (`countryCode`, `provinceSlug`, `verificationTier`, `trustSignals`, `informalEconomy`, etc.)
4. **`createdAt` + `updatedAt`** — required dates
5. **`qcStatus` enum** for any user/agent-generated content: `pending | validated | rejected | amended`
6. **`isActive: boolean`** for soft-delete pattern
7. **Strict validators**: `validationLevel: "moderate"`, `validationAction: "error"` — writes fail if schema violated
8. **OIDC standard claims** where applicable (`email`, `emailVerified`, `givenName`, `familyName`, `picture`, `locale`, `zoneinfo` — all in `persons`)
9. **Schema.org alignment** for content entities (`Place`, `LocalBusiness`, `Person`, `Observation`)

---

## Migration plan for mukoko-weather

### Decisions made (locked in)

- **No data migration.** Existing local `mukoko-weather` MongoDB data is abandoned. The app is rebuilt against the new platform schemas.
- **StationKit-first.** Mukoko-weather is a StationKit consumer. Architecture must accept `weather.observations` as ground truth, with Tomorrow.io / Open-Meteo as commercial fallback when no station is nearby.
- **Cross-DB reads.** Mukoko reads from `places` (locations), `identity` (users), `shamwari` (chat), `device` (devices), `integrations` (provider keys) — not from a single per-app DB.

### Phase 0 (rebuild kickoff — blocks all other phases)

- [x] Map the platform (this document)
- [x] Update `MONGODB_URI` in `.env.local` and Vercel
- [ ] **Refactor `api/py/_db.py`** to expose multi-DB accessors:
  - `weather_db()`, `places_db()`, `identity_db()`, `shamwari_db()`, `device_db()`, `integrations_db()`
  - All writes auto-stamp `_schemaVersion`, `createdAt`, `updatedAt`, `bundu` sub-doc
  - Strict adherence to validators (validators will reject writes with bad shape)
- [ ] **Refactor `src/lib/db.ts`** similarly for the TS side
- [ ] **Replace `src/lib/locations.ts`** static array — read from `places.places` (+ `places.placesGeo` for breadcrumb hierarchy). Add 5-min in-memory cache.
- [ ] **Rename `_db.py` API key reader** to read from `integrations.providerConfigurations` (with `credentialsReference.secretsStore: "platform_managed"`)
- [ ] **Add StationKit observation reader** — a Python helper `nearest_station_observation(lat, lon, max_distance_km=50)` that queries `weather.observations` ordered by `observedAt desc`. Returns `null` if no station within range.
- [ ] **Weather endpoint priority order**: `weather.observations` (StationKit, if within 50km) → Tomorrow.io → Open-Meteo → seasonal estimate
- [ ] **Rename `weather_reports` → `communityReports`** in code; new docs use camelCase + `qcStatus` + `reporterPersonId`
- [ ] **Stamp existing collection writes**: every doc we write to `weather.ai_summaries`, `weather.weather_cache`, etc. must include `_schemaVersion: "v3.1"`, `bundu: {...}`, `createdAt`, `updatedAt`

### Phase 1 (after Phase 0)

- [ ] WorkOS AuthKit → upsert into `identity.persons` on first sign-in
- [ ] Expo mobile app → register in `device.devices` with `userDevice` sub-doc
- [ ] AQI integration → write to a new `weather.airQualityCache` collection (or reuse `weather_cache` with `kind: "airquality"` discriminator)
- [ ] Severe weather alerts → **consume from `weather.alerts`** (no need to build the schema — it's there!)
- [ ] Push notifications → use `device.commands` for delivery, or `device.telemetry` for opt-in tracking

### Phase 2 (longer)

- [ ] Mobile app crash reports → `device.telemetry`
- [ ] Shamwari conversation persistence → `shamwari.conversations` + `shamwari.messages`
- [ ] Replace `src/lib/i18n.ts` with reads from `lingo` DB
- [ ] Status page → consume from `pulse` DB
- [ ] Community caretakers feature → `places.places.bundu.communityCaretakers`

---

## Pre-flight findings (verified via MongoDB MCP)

| DB             | Collection               | Count     | What's there                                                                                                                                                                                                                  | Mukoko action                                                                                                                                                                                                  |
| -------------- | ------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `places`       | `places`                 | **1567**  | Real-world places (e.g. "Miekles Hotel" `accommodation+localbusiness` in Harare). `hierarchy.containedInPlaceId` not yet linked. Type-mix is hotels/businesses/landmarks, **not** city centroids.                             | Mukoko needs to **seed African cities/towns** as places (placeType: `["Place"]`) so weather-page slugs like `/harare` work. Use `placesGeo` admin units to compute centroids, then write into `places.places`. |
| `places`       | `placesGeo`              | **1437**  | Administrative geography seeded — countries (Algeria, ISO `DZ`, population 45.4M), provinces, presumably cities.                                                                                                              | Use as canonical source for breadcrumbs (Country / Province / City). Replaces our hardcoded `COUNTRIES` and `PROVINCES`.                                                                                       |
| `identity`     | `persons`                | **1**     | Single founder user.                                                                                                                                                                                                          | Auth integration: WorkOS sign-in → upsert `identity.persons` by `workosUserId`. No migration needed.                                                                                                           |
| `integrations` | `providerConfigurations` | **8**     | All Zimbabwe-scoped (`appliesToCountryCodes: ["ZW"]`): tomorrow_io, open_meteo, workos, openstreetmap, geoboundaries, crowdsec, intercom, newsdata_io. **No MapTiler** yet.                                                   | Read configs by `providerSlug + appliesToCountryCodes`. Add MapTiler + Anthropic configs (for current country). Stop using local `api_keys` collection.                                                        |
| `integrations` | `providers`              | (catalog) | Each provider's metadata (license, sovereignty assessment, support flag).                                                                                                                                                     | Read-only reference.                                                                                                                                                                                           |
| `weather`      | `stations`               | **1**     | **The first StationKit station is live:** `nyuchi-africa-hq-harare`. Sensors: temperature, humidity, pressure, wind speed, wind direction, rainfall, UV index, solar radiation. QC rating: **excellent**. Status: **active**. | Mukoko must consume this. Build the `nearest_station_observation(lat, lon)` helper and prefer station data over Tomorrow.io when within 50 km of Harare.                                                       |
| `weather`      | `observations`           | (check)   | QC-validated observations from station(s).                                                                                                                                                                                    | Primary read path for mukoko.                                                                                                                                                                                  |
| `shamwari`     | `guardrails`             | **6**     | All `isCore: true`, all `appliesTo: []` (platform-wide). Sexual content, hate speech, harassment, violence, self-harm, abuse.                                                                                                 | Mukoko's AI system prompt must include `promptGuidance` from these guardrails. Read at startup, cache 5 min.                                                                                                   |

### Conclusions

- **No data migration.** The new platform was built fresh; nothing to migrate.
- **Cities are missing.** `places.places` has 1567 docs but they're commerce/hospitality places, not the city-level slugs mukoko uses for routing. We need a seed script.
- **StationKit is live (1 station).** The integration loop must be wired up before Phase 1, otherwise we can't validate the priority chain (Station → Tomorrow.io → Open-Meteo).
- **Provider configs are partial.** Tomorrow.io, Open-Meteo, WorkOS configured for ZW. MapTiler and Anthropic missing. Need to register them (or use platform-managed secrets).
- **Guardrails are platform-wide.** Mukoko's existing AI prompts must respect the 6 core categories.

---

## Location resolution (Phase 0F/0G — placesGeo canonical)

`weather.locations` is **dropped**. As of Phase 0G the Python backend also reads
exclusively through `places.placesGeo` — `api/py/_places_resolver.py` mirrors the
TypeScript resolver in `src/lib/places.ts`, and every read/write in `_history.py`,
`_chat.py`, `_explore_search.py`, `_reports.py`, `_weather.py`, and `_locations.py`
flows through it. The legacy `weather.countries` and `weather.provinces` collections
are also dropped — `placesGeo.geoType=country/province` is the canonical source.

Mukoko-weather reads/writes every location through `places.placesGeo` (admin
geography) + `places.places` (POIs from OSM/Fundi) via the helpers in
`src/lib/places.ts` (TypeScript) and `api/py/_places_resolver.py` (Python).

### Clean URL slug → placesGeo entry

Mukoko URLs use clean slugs (`/harare`, `/victoria-falls`) — NOT the hash-suffixed
platform slugs (`/harare-35c223`). The resolver in `src/lib/places.ts`
(`resolveLocationSlug`) maps clean → platform via three strategies (first hit wins):

1. **Stamped lookup**: `placesGeo.sourceProvenance.mukokoSlug = "harare"` (exact match)
2. **Name lookup via static seed**: clean slug `→ LOCATIONS[slug].name → placesGeo` by
   normalised name (case-insensitive, diacritic-stripped), preferring `geoType:
city > town > village`
3. **Name lookup via slug inference**: `"nairobi-ke" → "Nairobi"` (strips trailing
   2-letter country code, title-cases) → same name lookup

The adapter (`adaptPlacesGeoToLocationDoc`) reshapes the platform doc to the legacy
`LocationDoc` consumers in `src/app/[location]/*` expect (`lat`, `lon`, `name`,
`country`, `province`, `elevation`, `slug`, `_id`). Fields placesGeo doesn't carry
(tags, elevation, provinceSlug) fall back to `sourceProvenance.mukoko*` first, then
to the static `LOCATIONS` seed entry, then to `["city"]` / `0` defaults.

### Create-on-demand flow

When `resolveLocationSlug(slug)` returns null AND the request has lat/lon (IP geo
header or GPS coords), `POST /api/py/locations/add` runs:

```
1. Reverse-geocode lat/lon → { name, country ISO, province, nominatimAddress }
2. upsert_placesgeo_city(...) — Phase 0E helper:
     a. find_nearby_placesgeo() — 5 km radius, normalised-name match,
        scoped by parentPlaceId (country _id)
     b. If a pre-existing platform doc matches:
        - patch in mukokoSlug / mukokoTags / mukokoProvince /
          mukokoElevation / mukokoNominatimAddress
        - return { wasExisting: true, ... }
     c. Else insert a new placesGeo doc with sourceProvenance.dataOrigin:
        "mukoko_user" and all the mukoko* fields stamped
3. Return the new/existing placesGeo _id + slug to the caller
4. Caller redirects browser to /<clean-slug>
5. resolveLocationSlug() now finds the entry via sourceProvenance.mukokoSlug
   → render page
```

Phase 0F note: the `enqueue_fundi_seed()` POI enrichment call from the Phase 0E
flow is intentionally NOT triggered any more. POI seeding (`places.places` from
OSM via the Fundi worker) is a separate optional concern, not a P0 feature for
mukoko-weather. Re-enable behind a flag like `MUKOKO_ENRICH_POIS_VIA_FUNDI` once
the POI surface is wired up.

### Why queue-based? (Phase 0E historical — disabled in Phase 0F)

Fundi Places is a **separate service** exposed only via MCP. Python cannot call MCP tools directly, so mukoko cannot synchronously trigger a Fundi seed. The integration was therefore queue-based:

1. Mukoko writes a `places.seedRequests` doc with `status: "queued"`.
2. Fundi's worker polls the queue, processes each request, and updates its own status field (`processing` → `complete`/`error`).
3. Mukoko **fires and forgets** — there is no polling endpoint on the mukoko side. The user-facing response from `/api/py/locations/add` does not wait for Fundi.

**Phase 0F**: the `enqueue_fundi_seed()` call is no longer triggered by `add_location` /
`geo_lookup`. POI enrichment is a separate optional concern; re-enable behind a feature
flag once we actually consume `places.places` POIs in mukoko-weather.

### `places.seedRequests` shape

The collection is **validatorless** (Fundi owns the schema). The document mukoko writes:

```jsonc
{
  "_id": "<uuid>",
  "_schemaVersion": "v3.1",
  "status": "queued",
  "region": {
    "kind": "point_radius",
    "center": [lon, lat],      // GeoJSON-order [lon, lat]
    "radiusMeters": 5000
  },
  "source": {
    "kind": "search_miss",
    "surface": "mukoko-weather",
    "query": "<location name>",
    "requestedByPersonId": null   // populated once auth is wired
  },
  "categories": "all",
  "createdAt": "<iso datetime>",
  "updatedAt": "<iso datetime>",
  "startedAt": null,
  "finishedAt": null,
  "error": null,
  "placesCreated": null,
  "placesGeoCreated": null
}
```

### Dedup guarantees (Phase 0E hardening)

These rules prevent the duplicate-record corruption (`windsor-avenue-2`, `-3`, …) that earlier iterations produced:

| Collection                      | Dedup strategy                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `places.placesGeo`              | `upsert_placesgeo_city()` always calls `find_nearby_placesgeo()` first — **5 km radius**, normalised-name match (strips diacritics, road-type suffixes, leading house numbers), scoped by `parentPlaceId` (country \_id). If a match is found, the existing doc is returned with `wasExisting: true` — **no auto-suffixed slug is ever generated**.                      |
| `places.seedRequests`           | `enqueue_fundi_seed()` checks for an in-flight (`queued` or `processing`) request within **1 km**. If one exists, its `_id` is returned and no new doc is inserted.                                                                                                                                                                                                      |
| `places.placesGeo` mukoko slugs | Phase 0G: `_resolve_slug_collision()` queries `placesGeo.sourceProvenance.mukokoSlug` (mukoko's slug namespace) and tries suburb- then road-enriched variants. If all still collide, it raises `SlugCollisionError` and `add_location` returns `mode: "duplicate"` pointing to the existing record. The numeric-suffix fallback (`-2`, `-3`, …) was removed in Phase 0E. |

### Response shape changes

`/api/py/locations/add` now returns two extra platform-canonical identifiers when a new location is created:

```jsonc
{
  "mode": "created",
  "location": { /* legacy locations doc */ },
  "placesGeoId": "<placesGeo._id>",     // null only if the platform write failed
  "placesGeoSlug": "<placesGeo.slug>"   // hash-suffixed: "harare-a1b2c3"
}
```

The frontend can use these to resolve weather queries through `placesGeo` once the legacy `weather.locations` collection is decommissioned.

### Failure handling

The platform write is wrapped in `try/except` in `_locations.py:add_location` — **a placesGeo failure must never break the user-facing 201 response**. Phase 0G: the legacy `weather.locations` write is gone — `placesGeo` is now the only write target, and if it fails the response still includes the geocoded location data with `placesGeoId: null` / `placesGeoSlug: null`. Platform failures are logged as warnings.

---

### Phase 0 work list (locked plan)

1. **Refactor `api/py/_db.py`** to expose `weather_db()`, `places_db()`, `identity_db()`, `shamwari_db()`, `device_db()`, `integrations_db()` accessors.
2. **Seed `places.places`** with the 250+ African cities/towns we have locally (using `placesGeo` for ISO codes + admin hierarchy).
3. **Add `nearest_station_observation()`** helper in `api/py/_weather.py` — query `weather.observations` by `$nearSphere`, return latest within 50km.
4. **Update weather priority chain** in `/api/py/weather`: StationKit → Tomorrow.io → Open-Meteo → seasonal estimate.
5. **Read provider configs** from `integrations.providerConfigurations` instead of `api_keys` collection.
6. **Add MapTiler + Anthropic provider configs** to `integrations.providerConfigurations` (and `integrations.providers` if not registered).
7. **Adopt new schema** for all writes: `_schemaVersion: "v3.1"`, `bundu: {countryCode, provinceSlug}`, `createdAt`, `updatedAt`.
8. **Replace `weather_reports` → `weather.communityReports`** with new camelCase schema, `reporterPersonId` linking to identity.
9. **Inject guardrails** into Shamwari system prompt from `shamwari.guardrails` query.
10. **Update CLAUDE.md** with new platform-shared architecture.
