# Weather playbook

The one goal behind everything we build: **a person anywhere on Earth, and above all in Africa, opens Mukoko Weather and learns what the weather means for what they need to do today.**

Every `/loop` we run is an overarching objective that moves that goal. This file is the source for those loops: what each objective is, what moves it, who it helps, what is safe to do unattended, and what needs the owner.

Sources: the repo docs (`CLAUDE.md`, `README.md`, `workers/README.md`, `releases/`), the open `mukoko-dev/mukoko-weather` issues as of 2026-10-29, `mukoko-api`, `mukoko-weather-mobile` and `nyuchi-servers-api`. "Decided, not built" is said wherever that is the case. Nothing here was measured in production; metrics marked _not yet measured_ have no baseline.

## 1. Where weather stands

| Area           | Built                                                                                                                                                              | Decided, not built                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Web app        | `weather.mukoko.com` on Next.js: forecast, activity suitability, AI summary, map, aviation, community reports, history, `/display`, embed, `/locations`, `/releases` | Port to Astro (#293)                                                                         |
| Forecast       | Africa-weighted blend of six global models via Open-Meteo, Tomorrow.io enrichment only, seasonal fallback so a page never renders empty                            | Verification-fitted weights (groundwork only); self-hosted Open-Meteo (#280, code not live)  |
| Backend        | Rust Workers (forecast, places, aviation, stations, jobs, AI, tiles, public API) on `staging`; Python FastAPI still serves many routes                             | Rust-only (#333): port every remaining `/api/py` route, delete Python                        |
| Public API     | `mukoko-api` routes `/v1/weather/*` to the weather Worker; developer keys scoped `weather`                                                                         | Client cutover to `api.mukoko.com` (#174)                                                    |
| Mobile         | Expo app, thin client over the same API                                                                                                                            | Not in either store, no iOS submit config                                                    |
| Stations       | Ingest for Wunderground, Ecowitt and manual readings                                                                                                               | One active station today (Harare HQ)                                                         |
| Money          | Free and anonymous; AI gated on sign-in only                                                                                                                       | No entitlement or payment layer; payment provider is an open owner decision (#238)           |
| Platform fit   | Mongo platform DBs, placesGeo as the location source                                                                                                               | Owner order 2026-10-28 (#359): stop being a silo, use Places ids, CF names, WIGOS            |

## 2. Rules that hold for every loop

These are owner decisions already recorded in the repos. A loop that breaks one has failed.

1. **Backend is Rust Workers only.** Vercel is frontend only. `api/py` is frozen: no new features there, only ports out of it.
2. **A domain refers to another by id.** Geography is Places. Weather keeps no countries, provinces or regions of its own (#359). Agriculture is its own domain (`agriconnect`); weather adds no agriculture data store.
3. **Standards, not inventions.** CF standard names with units declared once, ISO 8601 with the place's IANA zone, ISO 3166 codes, WIGOS on stations, WMO 4677 weather codes, schema.org with JSON-LD.
4. **The coordinate is the identity, the name is cosmetic** (#317). No valid coordinate dead-ends.
5. **Tomorrow.io enriches, never carries the baseline** (#246).
6. **Never invent data.** A place with no crop calendar gets a derived window that names no crops. A provider outage serves the seasonal estimate, labelled.
7. **Errors are isolated per section.** A broken chart never takes down the page.
8. **Nothing is published, merged, deployed or released by a loop** without the owner's approval. The merge gate is: complete, CI green, verified at runtime, `/code-review` clean.
9. **Secrets, keys and credential status never go in files or public issues.**

## 3. Two entities, two scorecards

| Entity                  | Judged by                                                                                                       | Weather's job                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Nyuchi (Mukoko Weather) | Growth and community reach: users, retention, community activity. Aim for break-even; surplus flows to Bundu.   | The consumer product people open daily and tell others about.                                |
| Bundu Foundation        | Openness, rigour, community benefit. No revenue expectation.                                                    | Open data, open standards, research-grade rainfall and station records. No monetisation push. |

Objectives below say which scorecard they serve. Where one serves both, the Bundu side stays free and open.

## 4. The objectives (one `/loop` each)

Order is priority. Objectives 1 to 3 are the foundation and unblock the rest. Do not start a new objective's loop while an earlier one has an unresolved owner blocker that it depends on.

### Objective 1: Any place on Earth renders real weather

- **Entity:** Nyuchi. **Refs:** #317, #302, #273, #359.
- **Why:** A farmer, a pilot or a traveller who searches for a place and gets a dead end never comes back. Search, GPS and plain-name URLs now resolve worldwide (v0.12.0), but the location pipeline is still described for Africa first (#273) and holds its own location list (#359).
- **Metric moved:** share of searches and GPS fixes that end on a rendered weather page; 404 rate on real place names; search-to-page-view rate. _Not yet measured_: add the event first (see Objective 6 loop step).
- **Story to tell:** someone in Koh Samui, Gweru or a farm paddock with nothing mapped typed their place and got weather for exactly there.
- **Loop does:**
  1. Probe a fixed list of 50 places (Africa-heavy: rural Zimbabwe, Sahel, Indian Ocean islands; plus world cities, open water, polar) through search, GPS coordinates and bare-name URLs; record pass or fail.
  2. Fix failures in `workers/places` and `weather-core::resolve` with a native cargo test per fix.
  3. Replace the app's own location list with Places ids as #359 requires (read country and region from Places, never store them here).
- **Done when:** all 50 probes pass, and a test pins each past failure.
- **Safe now:** probes, native tests, fixes inside the Workers. **Needs sign-off:** any change to the Places schema or to what the Nyuchi API stores (platform-owned).

### Objective 2: One backend, Rust Workers, Python deleted

- **Entity:** Nyuchi. **Refs:** #333, #148, #174, #351, #297.
- **Why:** Two backends doubles the failure surface and keeps weather tied to Vercel. The owner decided Rust-only. Remaining Python routes are listed in #333 in four batches.
- **Metric moved:** share of app calls served by Workers (target 100%); p95 page-load; error rate on the page-load path; cold-start failures on the seed fallback.
- **Story to tell:** weather loads the same speed on a slow phone in Bulawayo as in Singapore, because the answer comes from the nearest edge, not a serverless cold start.
- **Loop does:** one batch per run, in the #333 order (page-load routes, then agriculture/model-grid/profile, then reference data, then writes). Per route: same JSON as the Python, shared fixtures between Python and Rust tests, same caching, breakers and budgets. Then repoint with no `/api/py` fallback.
- **Done when:** `api/py`, its tests and the Vercel rewrites are deleted, and `/api/py` has zero call sites in `src/`.
- **Safe now:** porting and tests, one batch at a time (disk is about 1.5 GB: share one cargo target dir). **Needs sign-off:** every deploy (`workers-deploy.yml`, behind the `workers-production` Environment), and the release blockers in #351 (Mongo bridge Worker, Atlas read-write user, index repairs). Those are owner steps.

### Objective 3: Weather stops being a silo

- **Entity:** both. **Refs:** #359, #150, #277, #265, #291.
- **Why:** The owner's order of 2026-10-28. Stations store `airTemperatureCelsius`-style names, not CF names; locations are not Places ids; weather has an agriculture endpoint that now belongs to another domain.
- **Metric moved:** none for users directly. It protects every later metric: fewer duplicate records, and other Nyuchi products can read weather without translation. Measure as count of weather-owned geography/agriculture collections (target 0).
- **Loop does:** an audit-then-migrate cycle against #359's change list: Places id on locations and stations; WIGOS id where a station has one; CF standard names with the unit declared once; ISO 8601 plus IANA zone; no stored countries or provinces; point `/agriculture` consumers at `agriconnect` when it serves them.
- **Done when:** a drift check (the `platform-architect` agent pattern) finds no weather-owned copy of geography or agriculture data.
- **Safe now:** read-only audit, renames behind adapters with tests. **Needs sign-off:** any data migration on the shared cluster, and anything that touches `data-infra` (private, not read in this pass: `nyuchi/data-infra#90` and `#117` must be read before this loop starts).

### Objective 4: Forecasts people can trust in Africa

- **Entity:** both. Free for everyone; the research is Bundu's. **Refs:** #246, #247, #245, #268, #280, and the station fleet.
- **Why:** Global models are weakest where our users are. The blend and fallback chain exist, but weights are a starting guess, nothing is verified against observations, history only recently resumed after stopping in July 2026 (#245), and we have one station.
- **Metric moved:** forecast error against observations per region (temperature and rain, 24 h and 48 h); number of validated stations; days of continuous history per place. _Not yet measured_: the verification docs are captured but no job joins them to observations.
- **Story to tell:** a school put a rain gauge and thermometer in the ground, typed in a reading, and the forecast for their village got better.
- **Loop does:**
  1. Build the verification join (captured forecasts against StationKit observations, else ERA5) and report error by region.
  2. Propose per-region weights into `modelBlendConfig` for the owner to approve.
  3. Prototype CHIRPS and TAMSAT point extraction for rainfall anomaly ("is this season drier than usual?"), as scoped in #247.
  4. Keep history healthy: assert one doc per place per day.
- **Done when:** a weekly error report exists per region and weights change only from that report.
- **Safe now:** analysis, reports, prototypes, tests. **Needs sign-off:** weight changes, ingest jobs that add Cloudflare cost, and the licensing question below.
- **StationKit is the load-bearing piece of this objective.** See section 4a.
- **Licensing blocker:** Open-Meteo's free API is non-commercial. Fine while we run at break-even and free, but any paid tier, or the developer API sold to businesses, needs the commercial plan, the self-hosted instance (#280, code ready, not deployed), or direct ECMWF/GFS/ICON ingestion. Decide before Objective 7.

### 4a. StationKit (`nyuchi/stationkit`)

StationKit is the station network that makes the loop "my station improves your forecast, your station improves mine" true, and it is the only way weather gets ground truth in places the models model badly.

**What exists (read 2026-10-29):**

- The repo is a README and a licence. There is **no firmware and no hardware design**. The device is specification only: ESP32-C3, ESP-IDF, solar plus 18650, 5-minute reads, hourly batches of 12, about 48 h of flash buffer. The README says the figures are targets, not measurements, and that no hardware has been built from the repo.
- The design record is four draft issues: #3 hardware, #4 firmware, #5 API contract, #6 data schema and QC. All carry `TODO` markers.
- What runs in production is elsewhere: the pilot signup on nyuchi.com, the console at `weatherstations.nyuchi.com`, and the ingest and QC pipeline in this repo (`/api/py/stations/*`, being ported to `workers/stations`). Any consumer station can already push through the Wunderground or Ecowitt "custom upload" protocols, and analog stations can submit by hand. One station is active: Nyuchi Africa HQ, Harare.

**Contract drift to resolve before any firmware is written** (nothing downstream can be built until it settles, as the README says):

| Topic         | StationKit draft (#5, #6)                                           | What this repo runs today                                                        | Platform rule (#359)                    |
| ------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------- |
| Endpoint      | `POST /v1/stations/{stationId}/readings`, bearer token per station | WU `GET` and Ecowitt `POST` with `PASSKEY=<stationId>:<ingestKey>`; manual `POST` | Not decided                             |
| Field names   | `temperatureC`, `windSpeedMs`, `rainfallMm`, `pressureHpa`           | `airTemperatureCelsius`, `windSpeedKph`, `precipitationMillimeters`              | CF standard names, unit declared once   |
| Wind unit     | m/s                                                                 | km/h                                                                             | CF `wind_speed` is m/s                  |
| QC            | Range, spike, cross-check against satellite data                    | Inline range check only; no spike or cross-validation                            | Not decided                             |
| Identity      | Station id and key                                                  | Station id and key                                                               | Places id plus WIGOS id where it exists |
| Publish onward | To Open-Meteo                                                       | Not found in this repo                                                           | Not decided                             |

Three name sets for the same quantities is the silo problem in miniature. The draft's m/s is the one that matches CF; the live code's km/h does not.

**Loop (daily, with Objective 4):**

1. Hold the contract in one place. Propose a single field and unit table (CF names, SI units) and a migration path from the live names. Do not edit #5 or #6 without the owner.
2. Add the missing QC (spike and outlier, cross-validation against the model blend) in `weather-core::station`, with native tests.
3. Verify the loop: when a station is within 50 km, `current` must come from StationKit (`X-Current-Source: stationkit`). Add a test that proves the overlay.
4. Report fleet health: stations active, last seen, QC pass rate.

**Done when:** one written contract, the Worker implements it, QC has spike and cross-check, and the fleet report exists.

**Safe now:** the contract proposal, QC code and tests, reports. **Needs sign-off:** the contract itself, anything on hardware spend or the BOM, the location-privacy policy for published data (#6 leaves it as a `TODO`), and the publish-onward path to Open-Meteo (a data-licence decision for the Bundu commons).

**Bundu scorecard:** station data goes into a commons the Bundu Foundation governs. Judge this work by openness and rigour (published QC rules, a documented schema, no relicensing path), not revenue.

**Also open in the repo:** #16 records that CodeQL scans only the workflow files, with no dependency audit or pre-commit scan. Fix it through the org-level layer (`nyuchi/.github`), per the owner's 2026-10-07 direction, not per-repo copies.

**Story to tell:** a school or smallholder joined with a rain gauge and a thermometer. Do not claim a hardware network exists: today it is one station plus any consumer station that points at our endpoint.

### Objective 5: Reach people where they are

- **Entity:** Nyuchi. **Refs:** #289, #320, #164, #171, #269, #282, and the mobile app.
- **Why:** A weather app is judged by whether it is on the home screen and warns you before the frost. Mobile is built but in neither store; web push is designed (frost alerts first) but nothing sends a push; `/display` for TVs and the embed widget are live but not promoted.
- **Metric moved:** installs (PWA and store), push opt-in rate, D7 and D30 retention, weekly active locations. _Not yet measured_: GA4 and Vercel Analytics exist; define the dashboard first.
- **Story to tell:** a smallholder got a frost warning the evening before and covered the seedlings. Collect these (with permission) and tell them plainly; do not use fear.
- **Loop does:** finish the PWA push path for frost (#289) on the Rust side; close the iOS-weather-grade gaps in #171 and #282; prepare mobile for the Play internal track and an iOS submit config; keep offline and repeat-load fast (#269).
- **Done when:** a frost alert is delivered end to end to a test device, and mobile has a store-ready build candidate.
- **Safe now:** code, tests, builds, preview channels. **Needs sign-off:** store submissions, push sender credentials, any message that reaches real users.

### Objective 6: Advice that changes what someone does

- **Entity:** Nyuchi (community side is also Bundu research). **Refs:** #265, #277, community reports, suitability engine, AI summaries.
- **Why:** The product's difference is the answer to "can I do the thing today": 60-odd activities with feasibility and tips, agriculture windows, place knowledge, community ground-truth. This is what makes the app worth opening instead of any other.
- **Metric moved:** share of sessions with a selected activity; activity-card interactions; community reports per week and their verified rate; AI summary helpfulness. _Not yet measured_: add events for activity adoption and report submission outcomes.
- **Loop does:** pick the three most-used regions, review the activity set and tips with local voices (Zimbabwean farming and mining vocabulary is the reference), fix unclear or wrong advice, and grow place-knowledge coverage without inventing specifics.
- **Done when:** each of the top activities has reviewed advice, and report volume per week is tracked.
- **Safe now:** copy, rules and tests. **Needs sign-off:** AI prompt changes (they move model behaviour for every user) and any new claim about crops, health or safety.

### Objective 7: Break-even without breaking the mission

- **Entity:** Nyuchi (fundraising is for scale; surplus flows to Bundu). **Refs:** #238, #174, #351, developer keys.
- **Why:** Aim is break-even, not profit. Costs that grow with users are the Workers, Open-Meteo, Tomorrow.io and AI. Revenue paths in the repo are designed, not built: paid AI summaries and a metered developer API.
- **Metric moved:** cost per active user; paying developer keys; partner agreements (mines, farms, schools, airlines) that fund coverage.
- **Loop does:** a monthly cost-per-user readout; a one-page paid-AI and developer-API option with the licensing consequence of each; no payment code until the provider is chosen.
- **Done when:** the owner has decided the payment provider and the Open-Meteo path.
- **Safe now:** costing and write-ups. **Needs sign-off:** the payment provider, any pricing, any commercial data licence. Do not build an entitlement layer ahead of that decision.

### Objective 8: Ship safely and tell the story

- **Entity:** both. **Refs:** `CONTRIBUTING.md`, `releases/`, the release blockers in #351.
- **Why:** The release train (`staging` to `main`) is how value reaches people; a red or held release is lost reach. Release notes at `/releases` are the community-facing record.
- **Metric moved:** time from merge to production; releases held by blockers; CI red rate.
- **Loop does:** keep the release PR mergeable and green; watch CI; draft each release's plain-language note in the house format (no PR numbers, code or model names).
- **Safe now:** CI repair, conflict resolution on branches this repo owns, draft notes. **Needs sign-off:** merge to `main`, deploys, publishing release notes.

## 5. How to communicate each objective

Marketing here is service and community storytelling. Each objective has a story shape; use real people with their permission, never invented ones.

| Objective        | Who to tell                                    | Channel                                                        | The story                                                              |
| ---------------- | ---------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1 Any place      | Travellers, diaspora, small towns that were missing | `/releases`, social (Postiz), WhatsApp groups                  | "Your town now has its own page, searched by its own name."            |
| 2 One backend    | Developers, partner apps                       | Developer docs, `/status`                                      | "Faster, and one API for every Mukoko app." Only after it is measured. |
| 3 No silo        | Internal and platform partners                 | Engineering notes                                              | Not a public story.                                                    |
| 4 Trust          | Farmers, schools, met-service contacts         | Direct outreach, station-owner onboarding                      | "Add a gauge, improve your village's forecast."                        |
| 5 Reach          | Smallholders, mining shifts, commuters         | Extension officers, WhatsApp, in-person demos, `/display` in offices | "A warning before the frost."                                          |
| 6 Advice         | Farmers, miners, coaches, pilots               | Short how-to posts per activity                                | "Today it is safe to spray between 06:00 and 09:00."                   |
| 7 Break-even     | Partners and funders                           | Partner briefs                                                 | Cost per person helped, honestly stated.                               |
| 8 Release notes  | Everyone                                       | `/releases`, Atom feed                                         | What changed for a person, in plain words.                             |

## 6. Loop templates

Run one objective per loop. Paste the block, filling the objective number. A loop reads this file first, does the smallest safe step, writes its result as an issue comment on the referenced issue (hand-off: done, left, branch), and ends with a single "Needs you:" line.

```text
/loop 1h Weather playbook, Objective <N> (docs/WEATHER_PLAYBOOK.md).
Read the objective and rules in section 2. Do the next smallest safe step
listed under "Loop does". Run the repo's checks for what you changed.
Never merge, deploy, publish or message users. Comment progress and the
hand-off on the referenced issue. End with "Needs you:".
```

Suggested cadence: Objectives 1, 2, 3 hourly while active; 4 and 6 daily; 5 daily once a store build exists; 7 monthly; 8 on every release PR.

## 7. Owner decisions waiting

Each of these blocks a named objective. A loop surfaces them; only the owner decides.

1. Payment provider for paid AI and the developer API (Objective 7, #238 P0-1).
2. StationKit: confirm the single field and unit contract (#5, #6) and whether the hardware build starts (Objective 4a).
3. Open-Meteo commercial path: plan, self-host on Railway (#280), or direct ingestion (Objectives 4 and 7).
4. Release blockers #351: Atlas read-write user for the Mongo bridge, index repairs, `placeKnowledge` details (Objective 2).
5. Whether the Astro port (#293) stays on the roadmap, given Rust-only is the stated priority. Recommendation: defer it until Objective 2 is done, since it replaces the front end the other objectives are still changing.
6. Mobile store submission and an iOS account (Objective 5).
7. Reading and approving the `data-infra` weather plan (`#90`, `#117`) so Objective 3 can start (private; not read in this pass).

## 8. What to leave alone for now

- New map base-map service (#298, replaces MapTiler; the `nyuchi/maps` repo is an empty shell, so there is nothing to build on yet) and new overlay sources (#272): real value, but they add architecture while the backend cutover is unfinished. Revisit after Objective 2.
- Shamwari full-page chat stays paused (flag off). AI stays ambient.
- Premium-maps, vector search and multi-language flags stay off.
- New weather data sources beyond rainfall (#247 lists more): one source at a time, after verification exists.

## 9. Known limits of this playbook

- Built from repo documents and issue titles and bodies (some truncated), not from production telemetry. No metric here has a measured baseline.
- StationKit was read from its README and issues #1 to #6 and #16. Hardware (#3) and firmware (#4) are specification with `TODO` markers: the BOM, panel, cell, rain gauge, anemometer and GSM modem parts are all unconfirmed, and OTA is undefined. Indicative kit prices are from $25 (Basic) and $65 (Full).
- `nyuchi/maps` was read from its repo: one commit, a one-line README, a licence, no code and no issues. The base-map plan lives in `mukoko-weather#298`, not here.
- `nyuchi-docs`, `nyuchi-platform` and `super-app-web` were searched for weather content only; `super-app-web` links out to weather rather than showing live data.
- Private issues in `data-infra` were not readable from this session.
