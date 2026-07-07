"""
Community weather stations — registration, data ingest, manual readings.

Consumer weather stations (Ecowitt/Fine Offset families, Ambient-style
consoles, Davis bridges) support a "custom server" upload: the console POSTs
its readings to any host on a schedule. This router gives those stations a
first-party destination — no Weather Underground middleman — plus a manual
path for analog stations (farmers/schools with rain gauges and min/max
thermometers but no digital infrastructure).

Endpoints:
  POST /api/py/stations/register      — create a station, ingest key shown ONCE
  GET  /api/py/stations/ingest        — Wunderground-protocol upload (query params)
  POST /api/py/stations/ingest        — Ecowitt-protocol upload (form fields)
  POST /api/py/stations/manual        — manual reading from an analog station
  GET  /api/py/stations/status        — last-seen + latest reading (owner console)

Data flow matches StationKit (Phase 0D): every accepted payload is stored
raw in weather.stationObservations; readings that pass the inline QC range
checks also become a validated weather.observations doc, which
/api/py/weather's nearest_station_observation() blends into current
conditions for every visitor within 50 km.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

from ._db import (
    check_rate_limit,
    get_client_ip,
    stamp_platform_fields,
    stations_collection,
    observations_collection,
    station_observations_collection,
)

router = APIRouter()

STATION_ID_RE = re.compile(r"^mws-[a-f0-9]{8}$")

# Inline QC — physically plausible ranges. Values outside stay in the raw
# stationObservations record but never become a validated observation.
QC_RANGES = {
    "airTemperatureCelsius": (-50.0, 60.0),
    "relativeHumidityPercent": (0.0, 100.0),
    "atmosphericPressureMillibar": (800.0, 1100.0),
    "windSpeedKph": (0.0, 250.0),
    "windGustKph": (0.0, 300.0),
    "windDirectionDegrees": (0.0, 360.0),
    "precipitationMillimeters": (0.0, 500.0),
    "uvIndex": (0.0, 20.0),
    "solarRadiationWm2": (0.0, 1500.0),
}


# Ingest keys are 192-bit random tokens (secrets.token_urlsafe(24)), not
# human passwords — but they're still stored only as salted PBKDF2-HMAC-SHA256
# hashes. Iterations are modest because the input is high-entropy (a slow KDF
# guards low-entropy passwords; here it just bounds per-ingest CPU, and
# stations report every 16-60s).
_KDF_ITERATIONS = 60_000


def _hash_key(key: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", key.encode("utf-8"), salt.encode("utf-8"), _KDF_ITERATIONS
    ).hex()


def _find_station(station_id: str, key: str) -> dict | None:
    """Resolve a station by id + ingest key (salted KDF compared). None on any miss."""
    if not station_id or not key or not STATION_ID_RE.match(station_id):
        return None
    try:
        doc = stations_collection().find_one({"stationId": station_id})
    except Exception:
        return None
    if not doc:
        return None
    salt = doc.get("ingestKeySalt") or ""
    expected = doc.get("ingestKeyHash") or ""
    if not salt or not expected:
        return None
    if not hmac.compare_digest(_hash_key(key, salt), expected):
        return None
    return doc


def _qc_filter(metrics: dict) -> dict:
    """Keep only metrics inside their plausible physical range."""
    passed = {}
    for field, value in metrics.items():
        if value is None:
            continue
        lo_hi = QC_RANGES.get(field)
        if lo_hi is None:
            continue
        lo, hi = lo_hi
        try:
            v = float(value)
        except (TypeError, ValueError):
            continue
        if lo <= v <= hi:
            passed[field] = round(v, 2)
    return passed


def _store_observation(station: dict, metrics: dict, raw: dict, source: str) -> dict:
    """
    Store the raw payload, and — when at least one metric passes QC — a
    validated observation the weather endpoint can blend. Returns a summary.
    """
    now = datetime.now(timezone.utc)
    country = ((station.get("bundu") or {}).get("countryCode")) or "ZW"

    raw_doc = stamp_platform_fields(
        {
            "stationId": station["stationId"],
            "receivedAt": now,
            "sourceType": source,
            "payload": {k: str(v)[:120] for k, v in list(raw.items())[:60]},
        },
        country_code=country,
    )
    try:
        station_observations_collection().insert_one(raw_doc)
    except Exception:
        pass  # Raw archive is best-effort — a validated observation still counts.

    validated = _qc_filter(metrics)
    if not validated:
        return {"accepted": 0, "qcStatus": "rejected"}

    obs_doc = stamp_platform_fields(
        {
            "stationId": station["stationId"],
            "location": station.get("location")
            or {"type": "Point", "coordinates": [station.get("lon"), station.get("lat")]},
            "observedAt": now,
            "qcStatus": "validated",
            "sourceType": source,
            "metrics": validated,
        },
        country_code=country,
    )
    observations_collection().insert_one(obs_doc)
    try:
        stations_collection().update_one(
            {"stationId": station["stationId"]},
            {"$set": {"lastObservationAt": now, "updatedAt": now}},
        )
    except Exception:
        pass
    return {"accepted": len(validated), "qcStatus": "validated"}


# ── Unit conversions (consoles speak imperial) ──────────────────────────────

def f_to_c(v):  # °F → °C
    return None if v is None else (float(v) - 32.0) * 5.0 / 9.0

def mph_to_kph(v):
    return None if v is None else float(v) * 1.609344

def inhg_to_hpa(v):
    return None if v is None else float(v) * 33.8639

def inch_to_mm(v):
    return None if v is None else float(v) * 25.4

def _num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# ── Registration ─────────────────────────────────────────────────────────────


class StationRegisterRequest(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    elevation: float | None = Field(default=None, ge=-430, le=9000)
    stationType: str = Field(default="digital", pattern="^(digital|manual)$")
    hardware: str | None = Field(default=None, max_length=80)
    country: str | None = Field(default=None, max_length=2)


@router.post("/api/py/stations/register")
async def register_station(body: StationRegisterRequest, request: Request = None):
    ip = get_client_ip(request) if request is not None else None
    if not ip:
        raise HTTPException(status_code=400, detail="Could not determine client IP")
    rate = check_rate_limit(ip, "station-register", 3, 3600)
    if not rate["allowed"]:
        raise HTTPException(status_code=429, detail="Too many station registrations — try again later")

    station_id = f"mws-{secrets.token_hex(4)}"
    ingest_key = secrets.token_urlsafe(24)
    ingest_salt = secrets.token_hex(16)

    doc = stamp_platform_fields(
        {
            "stationId": station_id,
            "name": body.name.strip(),
            "location": {"type": "Point", "coordinates": [body.lon, body.lat]},
            "lat": body.lat,
            "lon": body.lon,
            "elevation": body.elevation,
            "stationType": body.stationType,
            "hardware": (body.hardware or "").strip() or None,
            "status": "active",
            "ingestKeyHash": _hash_key(ingest_key, ingest_salt),
            "ingestKeySalt": ingest_salt,
            "lastObservationAt": None,
        },
        country_code=(body.country or "ZW").upper(),
    )
    stations_collection().insert_one(doc)

    # The full key is returned exactly ONCE — only its hash is stored.
    return {
        "stationId": station_id,
        "ingestKey": ingest_key,
        "stationType": body.stationType,
        "ingest": {
            "wunderground": {
                "server": "weather.mukoko.com",
                "path": "/api/py/stations/ingest",
                "params": "ID=<stationId>&PASSWORD=<ingestKey>",
            },
            "ecowitt": {
                "server": "weather.mukoko.com",
                "path": "/api/py/stations/ingest",
                "note": "Set the customized upload PASSKEY to <stationId>:<ingestKey>",
            },
        },
    }


# ── Ingest — Wunderground protocol (GET) ─────────────────────────────────────


@router.get("/api/py/stations/ingest")
async def ingest_wunderground(request: Request):
    q = request.query_params
    station = _find_station(q.get("ID", ""), q.get("PASSWORD", ""))
    if not station:
        return PlainTextResponse("unauthorized", status_code=401)

    metrics = {
        "airTemperatureCelsius": f_to_c(_num(q.get("tempf"))),
        "relativeHumidityPercent": _num(q.get("humidity")),
        "atmosphericPressureMillibar": inhg_to_hpa(_num(q.get("baromin"))),
        "windSpeedKph": mph_to_kph(_num(q.get("windspeedmph"))),
        "windGustKph": mph_to_kph(_num(q.get("windgustmph"))),
        "windDirectionDegrees": _num(q.get("winddir")),
        "precipitationMillimeters": inch_to_mm(_num(q.get("rainin"))),
        "uvIndex": _num(q.get("UV")),
        "solarRadiationWm2": _num(q.get("solarradiation")),
    }
    _store_observation(station, metrics, dict(q), source="wunderground")
    # The WU protocol expects the literal body "success".
    return PlainTextResponse("success")


# ── Ingest — Ecowitt protocol (POST form) ────────────────────────────────────


@router.post("/api/py/stations/ingest")
async def ingest_ecowitt(request: Request):
    try:
        form = await request.form()
    except Exception:
        return PlainTextResponse("bad request", status_code=400)
    passkey = str(form.get("PASSKEY", ""))
    station_id, _, key = passkey.partition(":")
    station = _find_station(station_id, key)
    if not station:
        return PlainTextResponse("unauthorized", status_code=401)

    g = lambda k: _num(form.get(k))  # noqa: E731
    metrics = {
        "airTemperatureCelsius": f_to_c(g("tempf")),
        "relativeHumidityPercent": g("humidity"),
        "atmosphericPressureMillibar": inhg_to_hpa(g("baromrelin") if form.get("baromrelin") else g("baromabsin")),
        "windSpeedKph": mph_to_kph(g("windspeedmph")),
        "windGustKph": mph_to_kph(g("windgustmph")),
        "windDirectionDegrees": g("winddir"),
        "precipitationMillimeters": inch_to_mm(g("rainratein")),
        "uvIndex": g("uv"),
        "solarRadiationWm2": g("solarradiation"),
    }
    _store_observation(station, metrics, dict(form), source="ecowitt")
    return PlainTextResponse("success")


# ── Manual readings (analog stations) ────────────────────────────────────────


class ManualReadingRequest(BaseModel):
    stationId: str
    key: str = Field(max_length=64)
    temperatureC: float | None = Field(default=None, ge=-50, le=60)
    humidityPercent: float | None = Field(default=None, ge=0, le=100)
    pressureHpa: float | None = Field(default=None, ge=800, le=1100)
    windKph: float | None = Field(default=None, ge=0, le=250)
    windDirectionDegrees: float | None = Field(default=None, ge=0, le=360)
    rainfallMm: float | None = Field(default=None, ge=0, le=500)
    notes: str | None = Field(default=None, max_length=280)


@router.post("/api/py/stations/manual")
async def manual_reading(body: ManualReadingRequest, request: Request = None):
    ip = get_client_ip(request) if request is not None else None
    if not ip:
        raise HTTPException(status_code=400, detail="Could not determine client IP")
    rate = check_rate_limit(ip, "station-manual", 12, 3600)
    if not rate["allowed"]:
        raise HTTPException(status_code=429, detail="Too many readings — try again later")

    station = _find_station(body.stationId, body.key)
    if not station:
        raise HTTPException(status_code=401, detail="Unknown station or key")

    metrics = {
        "airTemperatureCelsius": body.temperatureC,
        "relativeHumidityPercent": body.humidityPercent,
        "atmosphericPressureMillibar": body.pressureHpa,
        "windSpeedKph": body.windKph,
        "windDirectionDegrees": body.windDirectionDegrees,
        "precipitationMillimeters": body.rainfallMm,
    }
    raw = {k: v for k, v in metrics.items() if v is not None}
    if body.notes:
        raw["notes"] = body.notes
    if not raw:
        raise HTTPException(status_code=400, detail="At least one measurement is required")

    result = _store_observation(station, metrics, raw, source="manual")
    return JSONResponse(content=result)


# ── Owner console status ─────────────────────────────────────────────────────


@router.get("/api/py/stations/status")
async def station_status(id: str = "", key: str = ""):
    station = _find_station(id, key)
    if not station:
        raise HTTPException(status_code=401, detail="Unknown station or key")

    latest = None
    try:
        latest = observations_collection().find_one(
            {"stationId": station["stationId"]},
            sort=[("observedAt", -1)],
        )
    except Exception:
        pass

    last_at = station.get("lastObservationAt")
    return JSONResponse(
        content={
            "stationId": station["stationId"],
            "name": station.get("name"),
            "stationType": station.get("stationType", "digital"),
            "status": station.get("status", "active"),
            "lastObservationAt": last_at.isoformat() if isinstance(last_at, datetime) else last_at,
            "latestMetrics": (latest or {}).get("metrics"),
        }
    )
