# Self-hosted Open-Meteo (Railway, EU West / Amsterdam)

Runbook for running our own Open-Meteo instance, so that mukoko weather's
forecasts run under a commercial-use licence with no call caps. Nothing in
this directory is deployed automatically. Provisioning needs the owner's
approval of the cost (tracking issue: see "Links" below).

Owner decision: "for open meteor I want to run it on Railway hosted in Europe
or the UK". Railway has no UK region. Its only European region is **EU West
Metal, Amsterdam** (`europe-west4-drams3a`), so both services are pinned to it.

## Scope

The instance serves exactly what the app sends to Open-Meteo for forecasts:

| Endpoint          | Used by                                                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/forecast`    | the forecast Worker's `/v1/weather` (blend, single model, `best_match`, nowcast, model comparison), `/v1/model-grid` (per-model map layer, #272), `/v1/haze`, `/v1/status`, the TS direct-fetch fallback |
| `/v1/air-quality` | the Worker's `/v1/air-quality`, `/v1/air-quality/grid`, `/v1/haze` (CAMS)                                                                                                                                |

Out of scope:

- **ERA5 and the archive** (history backfill, `/v1/normals`). Owner
  decision: history is not self-hosted; it is pulled from an external API
  where it is needed. That work is tracked separately, so no archive config
  lives here.
- Geocoding and the `/v1/elevation` lookup in `api/py/_locations.py`.
- The optional edge layers (`worker/`, `workers/`). They still call the
  public API and can be moved in a follow-up.

## Architecture

```text
Vercel functions (iad1)  ─┐
Cloudflare Workers        ├─ HTTPS + X-Mukoko-OM-Key ─▶ om-gateway (Caddy, public domain)
                          ┘                                   │ key checked and stripped
                                                              ▼ private network (WireGuard, no egress fee)
                                                         open-meteo (API + sync, 100 GB volume, no public domain)
                                                              ▲
                                    AWS open data: openmeteo.s3.amazonaws.com (ingress, free)
```

Two Railway services in one project:

| Service      | Source                               | What it does                                                                                                                                                |
| ------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open-meteo` | `api/Dockerfile`, `api/railway.json` | The unmodified `ghcr.io/open-meteo/open-meteo` server plus a sync loop. It holds the volume and has no public domain.                                       |
| `om-gateway` | `gateway/`                           | Caddy with the only public domain. It allows `GET`/`HEAD` on the two endpoints, requires the key header, strips it before proxying, and drops it from logs. |

Why the API and the sync share one container: a Railway service can mount
only one volume, and a volume cannot be shared between services, so the
downloader has to run where the database lives. `api/entrypoint.sh` runs the
sync loop in the background and the API in the foreground.

Why a gateway rather than Open-Meteo's own keys: the built-in key
(`API_APIKEYS_PATH`) travels as an `apikey` query parameter, so it lands in
URLs and logs. A header checked at the edge keeps it out of both, and keeps
the API service itself off the internet.

The service **must** be named `open-meteo`. The gateway reaches it at
`open-meteo.railway.internal:8080` (override with `OM_UPSTREAM`).

## What is synced

`api/sync.conf` lists one Open-Meteo domain per line with only the stored
variables our requests need. Sizes were measured against the open-data
bucket on 2026-10-11 with `--past-days 7`:

| Domain                                                     | Blend member / use                                                               | Disk       | Runs/day |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------- | -------- |
| `ecmwf_ifs`                                                | `ecmwf_ifs` (IFS HRES 9 km)                                                      | 32.2 GB    | 4        |
| `ecmwf_aifs025_single`                                     | `ecmwf_aifs025_single`                                                           | 0.6 GB     | 4        |
| `ncep_gfs013` + `ncep_gfs025`                              | `gfs_seamless` (UV, lifted index)                                                | 15.7 GB    | 4        |
| `dwd_icon`                                                 | `icon_global`                                                                    | 8.7 GB     | 4        |
| `cmc_gem_gdps_15km`                                        | `gem_global`                                                                     | 6.6 GB     | 2        |
| `meteofrance_arpege_world025`                              | `meteofrance_arpege_world`                                                       | 1.6 GB     | 4        |
| `ncep_gefs025`, `ecmwf_ifs025_ensemble`, `dwd_icon_eps`    | precipitation probability                                                        | 1.1 GB     | 2–4      |
| `ecmwf_ifs025`, `dwd_icon_eu`, `meteofrance_arpege_europe` | user-selectable models (`ecmwf_ifs025`, `icon_seamless`, `meteofrance_seamless`) | 4.5 GB     | 4–8      |
| `cams_global`, `cams_europe`                               | `/v1/air-quality` (Europe picks `cams_europe`, the only NH3 source)              | 0.9 GB     | 1–2      |
| `copernicus_dem90`                                         | 90 m terrain downscaling (static)                                                | 10.5 GB    | —        |
| **Total**                                                  |                                                                                  | **~83 GB** |          |

Notes:

- `cmc_gem_gdps` stopped updating on the bucket in May 2026, so GEM comes
  from `cmc_gem_gdps_15km`. The smoke test checks that `gem_global` returns
  data.
- `sync` takes the domain and the variable list as positional arguments
  (there is no `--only-variables` flag). `--past-days` bounds the window, and
  the loop prunes chunks older than the window plus 3 days.
- Sync traffic is at most ~242 GB a day, if every changed chunk is fetched
  again on each run (~7.3 TB a month). It is **inbound**, which Railway does
  not bill, and the AWS open-data programme pays for it at the source.
- No ensemble members, ERA5 or pressure levels are synced.
- **Regional nests are not synced** (ICON-D2, AROME, HRRR, UKMO 2 km …).
  `best_match`, the app's single-request fallback, picks those for some
  European and North American points. With the forecast self-hosted, a
  `best_match` answer without temperatures is not cached or recorded: the app
  serves its seasonal estimate and records no breaker failure. The blend,
  the primary path everywhere, only uses the global members. `smoke.sh`
  reports those points as warnings.
- **Readiness:** on a new or re-created volume, `entrypoint.sh` finishes one
  complete sync before it starts serving (marker file
  `.mukoko-initial-sync-complete`). Until then the gateway answers 502 and the
  app degrades, rather than caching empty forecasts.

## Sizing and cost

Railway prices (docs, 2026-10-11): RAM $10/GB/month, CPU $20/vCPU/month,
volume $0.15/GB/month (used space), egress $0.05/GB, inbound free, private
networking free. Volumes over 5 GB need the **Pro plan** ($20/month, counted
against usage). Volumes give 3,000 read IOPS.

| Monthly (USD)                   | (a) Minimum: `sync.conf` as shipped |                    (b) Fuller set |
| ------------------------------- | ----------------------------------: | --------------------------------: |
| API compute (RAM)               |                     $40–80 (4–8 GB) |                      $160 (16 GB) |
| API compute (CPU)               |                      $10 (0.5 vCPU) |                      $20 (1 vCPU) |
| Gateway                         |                                 ~$2 |                               ~$2 |
| Volume (used GB)                |    $13 (~85 GB, 100 GB provisioned) | $26 (~175 GB, 250 GB provisioned) |
| Egress (responses to Vercel/CF) |                     ~$2.50 (~50 GB) |                     ~$5 (~100 GB) |
| Sync bandwidth (inbound)        |                      $0 (≤ ~7.3 TB) |                      $0 (≤ ~8 TB) |
| **Total** (Pro $20 included)    |                        **~$65–105** |                         **~$215** |

The fuller set adds `ukmo_global_deterministic_10km` and the regional nests
`best_match` uses in Europe and North America, with `--past-days 31`.
Upstream asks for 8 GB RAM minimum (16 GB recommended); start the minimum set
at 8 GB and right-size from Railway's metrics after a week.

Open-Meteo's commercial API (checked live on 2026-10-11): **Standard $29/month**
for 1M calls (forecast + air quality, no historical), **Professional $99/month**
for 5M calls (adds historical, climate, ensemble). A call is weighted:
`max(1, variables × models / 10)` per location, more beyond 14 days. Our
blend request is 44 variables × 6 models ≈ **26 calls**, and one 7×7 AQ grid
is **49 calls**. 5M calls cover about 190,000 blend fetches a month, which is
roughly 66 grid cells refreshed every 15 minutes, all day. Above that, or to
remove caps altogether, self-hosting is cheaper per call.

## Latency

All callers are server-side and our MongoDB cache (15 min weather, 1 h AQ)
absorbs most requests, so the round trip only applies on a cache miss.
Typical round-trip times to Amsterdam:

| From                                    | RTT (est.)           |
| --------------------------------------- | -------------------- |
| Vercel `iad1` (Washington DC)           | 75–90 ms             |
| Vercel `cpt1` (Cape Town)               | 150–170 ms           |
| Cloudflare Workers, European PoPs       | < 20 ms              |
| Cloudflare Workers, Johannesburg/Harare | 160–200 ms           |
| Nairobi / Lagos                         | 140–170 / 100–130 ms |

Open-Meteo reads many small chunks per request. On Railway's 3,000 IOPS
volume a cold 6-model request may take a few hundred milliseconds; the page
cache makes repeated nearby requests fast.

## AGPL-3.0

- Open-Meteo's server and image are AGPL-3.0; the data is CC BY 4.0.
  Upstream states self-hosting is allowed for commercial use.
- We run the image **unmodified**. Our Dockerfile adds a config file and a
  start script around the stock binary. Those are separate works that call
  it, not changes to it. AGPL §13 (offer the source to network users) is
  triggered by _modifying_ the program. Running an unmodified copy only
  requires keeping its licence and notices intact, which the image does.
- mukoko weather talks to it over HTTP, so the app is not a derivative work
  and its licence is unaffected.
- **If we ever patch Open-Meteo**, we must publish the complete modified
  source under AGPL-3.0 and offer it to everyone who interacts with that
  instance over the network (in practice, a public fork linked from the
  gateway's responses). Prefer upstream PRs or config over patches.
- Attribution: the footer credits the models via Open-Meteo (CC BY 4.0). CAMS
  data also asks for a Copernicus credit ("Contains modified Copernicus
  Atmosphere Monitoring Service information"). The footer does not carry it
  yet, whichever host serves the data. It is listed as a follow-up in the
  tracking issue.
- Caddy is Apache-2.0.

## Provisioning (after the owner approves the cost)

Do these in the Railway dashboard (or ask Claude with the Railway tools,
once approved):

1. **Plan.** Move the workspace to **Pro**. Hobby caps volumes at 5 GB.
2. **Project.** Create a project, e.g. `mukoko-open-meteo`. Set the preferred
   region to EU West (Amsterdam).
3. **`open-meteo` service.**
   - Name it exactly `open-meteo`. Source: GitHub `mukoko-dev/mukoko-weather`,
     branch `main`.
   - Settings → Config-as-code path: `infra/open-meteo/api/railway.json`.
   - Attach a volume mounted at `/app/data` and resize it to **100 GB**.
   - Variables: `RAILWAY_RUN_UID=0` (the image runs as a non-root user;
     Railway volumes need this). Optional: `SYNC_PAST_DAYS`,
     `SYNC_INTERVAL_MINUTES`.
   - Do **not** generate a public domain.
   - Watch the logs for `sync: <domain>` lines. The first full sync
     (~85 GB) takes roughly 1–3 hours, and the API only starts serving
     after it completes.
4. **`om-gateway` service.**
   - Same repo and branch. Config path: `infra/open-meteo/gateway/railway.json`.
   - Variable `OM_GATEWAY_KEY` = a new random key (`openssl rand -hex 32`).
     Store it only in Railway and Vercel; never paste it in an issue or chat.
   - Generate a Railway domain, or add a custom domain (e.g.
     `om.weather.mukoko.com`, CNAME in Cloudflare DNS, proxy off).
5. **Smoke test.**
   `OM_URL=https://<gateway-domain> OM_KEY=<key> sh infra/open-meteo/smoke.sh`
   must pass every line, including `gem_global`, `best_match` and the 401
   check.
6. **Cut over.** The Python backend that read these variables is gone: the
   Rust Workers call the public Open-Meteo hosts, and only the server-side
   direct-fetch fallback in the Next.js app (`src/lib/open-meteo-endpoint.ts`)
   still honours them. **Before this step, add the self-hosted base URL and the
   gateway key to the Workers' Open-Meteo calls** (forecast chain and extras,
   air quality and its grid, haze, agriculture, model grid, the status probe;
   the key as a Secrets Store secret). Then set the variables
   (`mukoko-weather` project in Vercel for the fallback, the Worker config for
   the Workers):
   - `OPEN_METEO_BASE_URL=https://<gateway-domain>`
   - `OPEN_METEO_AQ_BASE_URL=https://<gateway-domain>`
   - `OPEN_METEO_API_KEY=<key>` (sensitive)
   - Redeploy. `/status` then shows **Open-Meteo API (self-hosted)** and an
     **Open-Meteo Air Quality (self-hosted)** row. Check
     that `/v1/weather` still answers `X-Weather-Provider: open-meteo:blend`.
7. **Watch for a week.** Check Railway memory and CPU, `/status`, and the
   Open-Meteo breaker state. Then right-size RAM.

The forecast and air-quality variables are independent. Air quality can stay
on the public API (leave `OPEN_METEO_AQ_BASE_URL` unset) while the forecast
moves.

## Rollback

Remove the `OPEN_METEO_*` variables in Vercel and redeploy. Every call goes
back to the public API, with no code change.

## Rotating the key

1. Set `OM_GATEWAY_KEY_NEXT=<new>` on `om-gateway` and redeploy. Both keys
   now work.
2. Set `OPEN_METEO_API_KEY=<new>` in Vercel and redeploy.
3. Move the new value into `OM_GATEWAY_KEY`, clear `OM_GATEWAY_KEY_NEXT`, and
   redeploy the gateway.

The gateway refuses to start unless each key is at least 32 characters of
`[A-Za-z0-9_-]`. This also rules out Caddy's `*` wildcards.

## Upgrading Open-Meteo

Bump the tag and the digest in `api/Dockerfile` together, using a release at
least two weeks old. Get the digest with:

```bash
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:open-meteo/open-meteo:pull" | jq -r .token)
curl -sI -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  https://ghcr.io/v2/open-meteo/open-meteo/manifests/<tag> | grep -i docker-content-digest
```

Redeploying a service with a volume has a short outage (Railway never mounts
one volume into two deployments). During that window the app's breaker and
the 15-minute cache cover it, and the public API is not used automatically.

## Local test

`compose.yaml` runs both services locally. See the header of that file.

## Files

| File                   | Purpose                                                                       |
| ---------------------- | ----------------------------------------------------------------------------- |
| `api/Dockerfile`       | Pinned upstream image, the sync list and the start script; per-IP limiter off |
| `api/entrypoint.sh`    | Sync loop (one `sync` per domain, prune) plus `serve`                         |
| `api/sync.conf`        | Domains and variables to sync                                                 |
| `api/railway.json`     | Region pin and restart policy                                                 |
| `gateway/Caddyfile`    | Header-key auth, path/method allowlist, key stripped and dropped from logs    |
| `gateway/start.sh`     | Fails closed on a weak or missing key                                         |
| `gateway/railway.json` | Region pin and `/healthz` healthcheck                                         |
| `smoke.sh`             | Post-deploy check of every member, the nowcast, CAMS and the 401              |
| `compose.yaml`         | Local two-service stack                                                       |

## Links

- Upstream docs: <https://github.com/open-meteo/open-meteo/tree/main/docs>
- Open data and model list: <https://github.com/open-meteo/open-data>
- Pricing: <https://open-meteo.com/en/pricing>
- Railway regions, volumes and pricing: <https://docs.railway.com/deployments/regions>,
  <https://docs.railway.com/volumes/reference>, <https://docs.railway.com/pricing/plans>
- Issues: #246 (model baseline), #238 (P0-1 premium/subscription)
