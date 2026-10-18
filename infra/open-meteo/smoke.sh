#!/bin/sh
# Smoke-test a self-hosted Open-Meteo gateway with the exact shapes mukoko
# weather requests. Reads the key from the environment and never prints it.
#
#   OM_URL=https://<gateway-domain> OM_KEY=... sh infra/open-meteo/smoke.sh
#
# Exits non-zero if any blend member, the nowcast, CAMS or the auth check fails.
set -eu
: "${OM_URL:?set OM_URL to the gateway origin}"
: "${OM_KEY:?set OM_KEY to the gateway key}"
HEADER="X-Mukoko-OM-Key"   # fixed; must match gateway/Caddyfile
LAT="${LAT:--17.83}"; LON="${LON:-31.05}"   # Harare
fail=0
warn=0

get() { curl -fsS --max-time 60 -H "$HEADER: $OM_KEY" "$OM_URL$1"; }

check() {
  label="$1"; path="$2"; expr="$3"
  if out="$(get "$path")" && printf '%s' "$out" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if ($expr) else 1)"; then
    echo "ok    $label"
  else
    echo "FAIL  $label"; fail=1
  fi
}

for m in ecmwf_ifs ecmwf_aifs025_single gfs_seamless icon_global gem_global meteofrance_arpege_world; do
  check "forecast $m" \
    "/v1/forecast?latitude=$LAT&longitude=$LON&models=$m&hourly=temperature_2m,precipitation,wind_speed_10m,cloud_cover&forecast_days=3" \
    "any(v is not None for v in d['hourly']['temperature_2m'])"
done
check "blend call shape (all members + daily + minutely)" \
  "/v1/forecast?latitude=$LAT&longitude=$LON&models=ecmwf_ifs,ecmwf_aifs025_single,gfs_seamless,icon_global,gem_global,meteofrance_arpege_world&current=temperature_2m,weather_code,uv_index&hourly=temperature_2m,precipitation_probability,uv_index,visibility,cape,lifted_index&daily=temperature_2m_max,et0_fao_evapotranspiration&minutely_15=precipitation&forecast_minutely_15=8&timezone=auto&forecast_days=7" \
  "d['current'].get('temperature_2m') is not None and len(d['minutely_15']['precipitation'])==8"
check "best_match fallback" \
  "/v1/forecast?latitude=$LAT&longitude=$LON&hourly=temperature_2m&forecast_days=2" \
  "any(v is not None for v in d['hourly']['temperature_2m'])"
check "air quality (CAMS)" \
  "/v1/air-quality?latitude=$LAT&longitude=$LON&current=pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide&hourly=us_aqi&past_days=1&timezone=auto" \
  "d['current'].get('pm2_5') is not None and any(v is not None for v in d['hourly']['us_aqi'])"

# User-selectable models outside the blend.
for m in ecmwf_ifs025 icon_seamless meteofrance_seamless; do
  check "forecast $m (selectable)" \
    "/v1/forecast?latitude=$LAT&longitude=$LON&models=$m&hourly=temperature_2m&forecast_days=2" \
    "any(v is not None for v in d['hourly']['temperature_2m'])"
done

# Informational: best_match and CAMS outside Africa may hit domains we do not
# sync (regional nests). The app degrades these to seasonal estimates.
soft() {
  label="$1"; path="$2"; expr="$3"
  if out="$(get "$path")" && printf '%s' "$out" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if ($expr) else 1)"; then
    echo "ok    $label"
  else
    echo "warn  $label"; warn=1
  fi
}
soft "best_match Amsterdam" "/v1/forecast?latitude=52.37&longitude=4.90&hourly=temperature_2m&forecast_days=2" \
  "any(v is not None for v in d['hourly']['temperature_2m'])"
soft "best_match New York" "/v1/forecast?latitude=40.71&longitude=-74.01&hourly=temperature_2m&forecast_days=2" \
  "any(v is not None for v in d['hourly']['temperature_2m'])"
soft "air quality Amsterdam (cams_europe)" "/v1/air-quality?latitude=52.37&longitude=4.90&current=pm2_5,ammonia" \
  "d['current'].get('pm2_5') is not None"

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$OM_URL/v1/forecast?latitude=$LAT&longitude=$LON&hourly=temperature_2m" || true)"
if [ "$code" = "401" ]; then echo "ok    no key -> 401"; else echo "FAIL  no key -> $code (expected 401)"; fail=1; fi

[ "$warn" = 0 ] || echo "(warnings are informational; see README \"What is synced\")"
exit "$fail"
