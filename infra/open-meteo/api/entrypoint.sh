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

sync_once() {
  # One `sync` per domain so each gets only its own variables.
  grep -v '^[[:space:]]*#' "$SYNC_CONF" | while read -r domain variables; do
    [ -n "${domain:-}" ] || continue
    echo "sync: $domain"
    ./openmeteo-api sync "$domain" "$variables" --past-days "$SYNC_PAST_DAYS" \
      || echo "sync: $domain failed; retrying next round" >&2
  done
}

sync_loop() {
  while :; do
    sync_once
    if [ "${SYNC_PRUNE:-true}" = "true" ]; then
      # Drop rolling-timeseries chunks older than the window (upstream's own
      # cleanup recipe, docs/sync-command.md). Static files are kept.
      find "$DATA_DIR" -type f -name 'chunk_*' -mtime +"$((SYNC_PAST_DAYS + 3))" -delete || true
    fi
    sleep "$((SYNC_INTERVAL_MINUTES * 60))"
  done
}

if [ "${SYNC_ENABLED:-true}" = "true" ]; then
  sync_loop &
fi

exec ./openmeteo-api serve --env production --hostname "${API_HOST:-::}" --port "${PORT:-8080}"
