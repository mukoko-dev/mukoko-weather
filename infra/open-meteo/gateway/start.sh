#!/bin/sh
# Fail closed: never serve with a missing, short or wildcard-capable key.
set -eu

check_key() {
  name="$1"; value="$2"
  if [ "${#value}" -lt 32 ] || printf '%s' "$value" | grep -q '[^A-Za-z0-9_-]'; then
    echo "gateway: $name must be at least 32 characters of [A-Za-z0-9_-]" >&2
    exit 1
  fi
}

check_key OM_GATEWAY_KEY "${OM_GATEWAY_KEY:-}"
if [ -n "${OM_GATEWAY_KEY_NEXT:-}" ]; then
  check_key OM_GATEWAY_KEY_NEXT "$OM_GATEWAY_KEY_NEXT"
else
  # No second key: fill the slot with a random value nobody knows.
  OM_GATEWAY_KEY_NEXT="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  export OM_GATEWAY_KEY_NEXT
fi
export OM_UPSTREAM="${OM_UPSTREAM:-open-meteo.railway.internal:8080}"

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
