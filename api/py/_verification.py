"""
Forecast verification capture — groundwork for fitting blend weights (#246).

Every fresh blended baseline fetch stores what EACH member model (and the
blend) forecast at a few lead times. A later job (not built yet) joins these
by ``validAt`` against what actually happened —

1. StationKit ``weather.observations`` within 25 km and ±30 min, else
2. ERA5 reanalysis via the Open-Meteo archive API —

and fits per-region weights by measured skill (inverse-MSE / CRPS), writing
them to ``weather.model_blend_config`` which ``_model_blend.weights_for``
already reads.

Volume is bounded: at most one doc per location per 6-hour issuance bucket
(``_id`` = ``{slug}:{YYYYMMDDHH of bucket start}``, upserted), each ~a few KB,
TTL 180 days via ``expiresAt``.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

#: Hours ahead captured.
LEAD_HOURS = (6, 24, 48, 72)
#: Variables captured per member.
VERIFY_VARS = ("temperature_2m", "precipitation", "wind_speed_10m")
ISSUANCE_BUCKET_H = 6
RETENTION_DAYS = 180


def _bucket_start(now: datetime) -> datetime:
    return now.replace(minute=0, second=0, microsecond=0, hour=(now.hour // ISSUANCE_BUCKET_H) * ISSUANCE_BUCKET_H)


def build_verification_doc(
    slug: str,
    lat: float,
    lon: float,
    region: str,
    weights: dict[str, float],
    raw: dict,
    blended_hourly: dict,
    start_index: int,
    now: datetime | None = None,
) -> dict | None:
    """Build the capture doc from the raw multi-model response + the blend."""
    now = now or datetime.now(timezone.utc)
    hourly = raw.get("hourly") or {}
    times = hourly.get("time") or []
    leads: dict = {}
    for lead in LEAD_HOURS:
        i = start_index + lead
        if i >= len(times):
            continue
        members: dict = {}
        for model in weights:
            values = {}
            for var in VERIFY_VARS:
                arr = hourly.get(f"{var}_{model}") or []
                if i < len(arr) and arr[i] is not None:
                    values[var] = arr[i]
            if values:
                members[model] = values
        blend = {}
        for var in VERIFY_VARS:
            arr = blended_hourly.get(var) or []
            if i < len(arr):
                blend[var] = arr[i]
        if members:
            leads[str(lead)] = {"validAtLocal": times[i], "members": members, "blend": blend}
    if not leads:
        return None
    issued = _bucket_start(now)
    return {
        "_id": f"{slug}:{issued.strftime('%Y%m%d%H')}",
        "locationSlug": slug,
        "location": {"type": "Point", "coordinates": [lon, lat]},
        "region": region,
        "weights": weights,
        "issuedAt": issued,
        "utcOffsetSeconds": raw.get("utc_offset_seconds"),
        "leads": leads,
        "verified": False,
        "createdAt": now,
        "expiresAt": now + timedelta(days=RETENTION_DAYS),
    }


def capture(doc: dict | None) -> None:
    """Upsert the capture doc (first write per bucket wins). Never raises."""
    if not doc:
        return
    try:
        from ._db import weather_db

        weather_db()["forecast_verification"].update_one(
            {"_id": doc["_id"]},
            {"$setOnInsert": {k: v for k, v in doc.items() if k != "_id"}},
            upsert=True,
        )
    except Exception:
        pass
