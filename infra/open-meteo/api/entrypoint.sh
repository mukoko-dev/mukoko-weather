#!/bin/sh
# Runs the UNMODIFIED Open-Meteo server and keeps its database current.
#
# Railway gives a service one volume, and the API and the sync must share it,
# so both run in this one container: the sync loop in the background, the API
# in the foreground (its exit ends the container and Railway restarts it).
set -eu

DATA_DIR="${DATA_DIRECTORY:-/app/data}"
SYNC_CONF="${SYNC_CONF:-/app/sync.conf}"
SYNC_PAST_DAYS="${SYNC_PAST_DAYS:-7}"
SYNC_INTERVAL_MINUTES="${SYNC_INTERVAL_MINUTES:-10}"
export DATA_DIRECTORY="$DATA_DIR"

mkdir -p "$DATA_DIR"

READY_MARKER="$DATA_DIR/.mukoko-initial-sync-complete"

# One `sync` per domain so each gets only its own variables. Returns non-zero
# if any domain failed (the others still run).
sync_once() {
  status=0
  domains="$(grep -v '^[[:space:]]*#' "$SYNC_CONF" | grep -v '^[[:space:]]*$' || true)"
  # A here-doc keeps the loop in this shell, so `status` survives it.
  while read -r domain variables; do
    [ -n "${domain:-}" ] || continue
    echo "sync: $domain"
    if ! ./openmeteo-api sync "$domain" "$variables" --past-days "$SYNC_PAST_DAYS" </dev/null; then
      echo "sync: $domain failed; retrying next round" >&2
      status=1
    fi
  done <<DOMAINS
$domains
DOMAINS
  return "$status"
}

sync_loop() {
  while :; do
    sleep "$((SYNC_INTERVAL_MINUTES * 60))"
    sync_once || true
    if [ "${SYNC_PRUNE:-true}" = "true" ]; then
      # Drop rolling-timeseries chunks older than the window (upstream's own
      # cleanup recipe, docs/sync-command.md). Static files are kept.
      find "$DATA_DIR" -type f -name 'chunk_*' -mtime +"$((SYNC_PAST_DAYS + 3))" -delete || true
    fi
  done
}

if [ "${SYNC_ENABLED:-true}" = "true" ]; then
  # Readiness: on a new (or re-created) volume, do not serve until one full
  # sync has succeeded. Otherwise the API would answer 200 with null series
  # for hours, and callers would cache them. While this runs the gateway
  # returns 502, the app's breaker opens and pages show seasonal estimates.
  until [ -f "$READY_MARKER" ]; do
    if sync_once; then
      touch "$READY_MARKER"
    else
      echo "sync: initial sync incomplete; retrying in 60 s" >&2
      sleep 60
    fi
  done
  sync_loop &
fi

exec ./openmeteo-api serve --env production --hostname "${API_HOST:-::}" --port "${PORT:-8080}"
