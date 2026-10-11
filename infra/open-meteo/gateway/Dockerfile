# Authenticated edge in front of the self-hosted Open-Meteo API.
# Caddy (Apache-2.0), pinned by version and digest.
# Build context: the repository root (Railway builds from the repo root).
FROM caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b

COPY infra/open-meteo/gateway/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=0755 infra/open-meteo/gateway/start.sh /usr/local/bin/start.sh
RUN OM_GATEWAY_KEY=build-time-validation-key-0000000000 \
    OM_GATEWAY_KEY_NEXT=build-time-validation-key-1111111111 \
    OM_UPSTREAM=127.0.0.1:8080 \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

EXPOSE 8080
CMD ["/usr/local/bin/start.sh"]
