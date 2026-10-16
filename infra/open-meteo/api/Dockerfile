# Self-hosted Open-Meteo API + database sync for mukoko weather.
#
# The upstream image is used UNMODIFIED (AGPL-3.0, see ../README.md "AGPL").
# This layer only adds our sync list and a start script around the stock
# `openmeteo-api` binary; nothing in the Open-Meteo program is changed.
#
# Build context: the repository root (Railway builds from the repo root).
#
# Pinned by version AND digest so a rebuild never picks up a new release
# silently. Bump both together (README "Upgrading").
FROM ghcr.io/open-meteo/open-meteo:1.6.0@sha256:e1517a01a061fd96e2a9017d022c5809bb51725bcd733bcbed435e7ea32dd9da

COPY --chown=openmeteo:openmeteo infra/open-meteo/api/sync.conf /app/sync.conf
COPY --chown=openmeteo:openmeteo --chmod=0755 infra/open-meteo/api/entrypoint.sh /app/entrypoint.sh

# The server's built-in free-tier limiter (10,000 weighted calls a day and one
# concurrent request per caller IP) only engages when the Host header names
# an *.open-meteo.com host, which ours never does. Every request arrives from
# the gateway's one IP, so it is switched off here as well, in case a later
# release applies it to every host. 0 disables the call limits.
ENV DATA_DIRECTORY=/app/data \
    CALL_LIMIT_DAILY=0 \
    CALL_LIMIT_HOURLY=0 \
    CALL_LIMIT_MINUTELY=0 \
    CONCURRENCY_LIMIT=64 \
    CONCURRENCY_LIMIT_HARD=256 \
    PORT=8080

EXPOSE 8080

# The upstream image already runs as this unprivileged user; stated here so
# the final user is explicit. On Railway, RAILWAY_RUN_UID=0 is needed only
# because its volumes mount root-owned (README "Provisioning").
USER openmeteo:openmeteo

ENTRYPOINT ["/app/entrypoint.sh"]
