"""
Africa-weighted multi-model forecast baseline (issue #246).

The forecast BASELINE is a weighted blend of the global NWP models that
Open-Meteo serves keyless. Tomorrow.io is no longer the baseline — it only
enriches ``insights`` (see ``_enrichment.py``).

Model ids were checked live against ``api.open-meteo.com/v1/forecast`` on
2026-10-10. Note ``ecmwf_ifs04`` is DEAD upstream (all-null series); it is
accepted as a legacy alias for ``ecmwf_ifs`` so stored user preferences keep
working.

Blend rules (per variable, per time step):

* Weighted mean over the members that HAVE a value, weights renormalised over
  those present — so a variable only some members publish (UV, lifted index:
  GFS only) comes from those members alone.
* Wind direction: circular (vector) weighted mean.
* WMO weather code: weighted vote; ties go to the higher (more severe) code.
* ``is_day``, ``sunrise``, ``sunset`` and other non-numeric fields: first
  non-null member value.
* Precipitation probability: ``0.5 × ensemble + 0.5 × agreement`` when any
  member supplies an (ensemble-derived) probability, else agreement alone.
  Agreement = weighted share of members forecasting ≥ 0.1 mm (hourly) or
  ≥ 1 mm (daily).
* ``current``: Open-Meteo returns ``current`` only for the FIRST listed model,
  so the highest-weight member is listed first; its nulls are filled from the
  blended hourly value at the current hour.
"""

from __future__ import annotations

import math
import time
from typing import Iterable

# ---------------------------------------------------------------------------
# Model ids + regional weights
# ---------------------------------------------------------------------------

ECMWF_IFS = "ecmwf_ifs"  # ECMWF IFS HRES 9 km (open data, CC BY 4.0)
ECMWF_IFS025 = "ecmwf_ifs025"  # ECMWF IFS 0.25° (same model, coarser)
ECMWF_AIFS = "ecmwf_aifs025_single"  # ECMWF AIFS 0.25° (machine-learning model)
GFS = "gfs_seamless"  # NOAA GFS (only member with UV + lifted index)
ICON = "icon_global"  # DWD ICON global
GEM = "gem_global"  # ECCC GEM global
ARPEGE = "meteofrance_arpege_world"  # Météo-France ARPEGE world

#: Legacy / renamed ids → current id.
MODEL_ALIASES = {"ecmwf_ifs04": ECMWF_IFS}

#: Starting weights — ECMWF-heavy everywhere (owner direction). Tune per
#: region via a ``weather.modelBlendConfig`` doc (``_id`` = region key,
#: ``weights`` = {model: weight}) once verification data
#: (``_verification.py``) supports fitting by measured skill.
_ECMWF_HEAVY = {
    ECMWF_IFS: 0.35,
    ECMWF_AIFS: 0.25,
    GFS: 0.15,
    ICON: 0.15,
    GEM: 0.05,
    ARPEGE: 0.05,
}

BLEND_WEIGHTS: dict[str, dict[str, float]] = {
    "southern-africa": dict(_ECMWF_HEAVY),
    "east-africa": dict(_ECMWF_HEAVY),
    "west-africa-sahel": dict(_ECMWF_HEAVY),
    "central-africa": dict(_ECMWF_HEAVY),
    "north-africa": dict(_ECMWF_HEAVY),
    "default": dict(_ECMWF_HEAVY),
}

#: Region bounding boxes (lat_min, lat_max, lon_min, lon_max). First match
#: wins, so the order matters where boxes touch.
REGION_BOXES: tuple[tuple[str, tuple[float, float, float, float]], ...] = (
    ("north-africa", (19.0, 38.0, -18.0, 37.0)),
    ("west-africa-sahel", (3.0, 19.0, -18.0, 16.0)),
    ("east-africa", (-12.0, 19.0, 28.0, 52.0)),
    ("central-africa", (-12.0, 12.0, 8.0, 31.0)),
    ("southern-africa", (-35.5, -12.0, 10.0, 52.0)),
)


def region_for(lat: float, lon: float) -> str:
    """Blend-weight region key for a coordinate (``default`` outside Africa)."""
    for key, (lat_min, lat_max, lon_min, lon_max) in REGION_BOXES:
        if lat_min <= lat <= lat_max and lon_min <= lon <= lon_max:
            return key
    return "default"


_config_cache: dict[str, tuple[float, dict[str, float]]] = {}
_CONFIG_TTL_S = 300


def _reset_config_cache() -> None:
    _config_cache.clear()


def weights_for(region: str) -> dict[str, float]:
    """Weights for ``region``: DB override (5-min cache) → constant → default.

    Any DB problem silently falls back to :data:`BLEND_WEIGHTS`. Unknown model
    ids and non-positive weights in an override are dropped.
    """
    now = time.time()
    hit = _config_cache.get(region)
    if hit and now - hit[0] < _CONFIG_TTL_S:
        return dict(hit[1])

    weights = dict(BLEND_WEIGHTS.get(region) or BLEND_WEIGHTS["default"])
    try:
        from ._db import weather_db

        doc = weather_db()["modelBlendConfig"].find_one({"_id": region}, {"weights": 1})
        override = (doc or {}).get("weights")
        if isinstance(override, dict):
            cleaned = {
                m: float(w)
                for m, w in override.items()
                if m in BLENDABLE_MODELS and isinstance(w, (int, float)) and w > 0
            }
            if cleaned:
                weights = cleaned
    except Exception:
        pass
    _config_cache[region] = (now, weights)
    return dict(weights)


#: Models that may appear in a blend.
BLENDABLE_MODELS = {ECMWF_IFS, ECMWF_IFS025, ECMWF_AIFS, GFS, ICON, GEM, ARPEGE}


def order_members(weights: dict[str, float]) -> list[str]:
    """Members sorted by weight, highest first (the first supplies ``current``)."""
    return [m for m, _ in sorted(weights.items(), key=lambda kv: (-kv[1], kv[0]))]


# ---------------------------------------------------------------------------
# Open-Meteo request shape
# ---------------------------------------------------------------------------

CURRENT_VARS = (
    "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,"
    "wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure,cloud_cover,uv_index,is_day"
)
HOURLY_VARS = (
    "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation_probability,precipitation,"
    "weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure,cloud_cover,"
    "uv_index,visibility,is_day,dew_point_2m,cape,lifted_index"
)
DAILY_VARS = (
    "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,"
    "sunrise,sunset,uv_index_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,"
    "wind_gusts_10m_max,wind_direction_10m_dominant,et0_fao_evapotranspiration"
)

_DIRECTION_FIELDS = {"wind_direction_10m", "wind_direction_10m_dominant"}
_CODE_FIELDS = {"weather_code"}
_PROB_FIELDS = {"precipitation_probability", "precipitation_probability_max"}
_FIRST_FIELDS = {"is_day", "sunrise", "sunset", "time"}


def _num(v) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    return float(v)


def _member_value(section: dict, var: str, model: str, i: int, single: bool):
    key = var if single else f"{var}_{model}"
    arr = section.get(key)
    if arr is None:
        return None
    try:
        return arr[i]
    except (IndexError, TypeError):
        return None


def _weighted_mean(pairs: Iterable[tuple[float, float]]) -> float | None:
    total_w = 0.0
    total = 0.0
    for value, w in pairs:
        total += value * w
        total_w += w
    if total_w <= 0:
        return None
    return total / total_w


def _circular_mean(pairs: Iterable[tuple[float, float]]) -> float | None:
    x = y = total_w = 0.0
    for deg, w in pairs:
        rad = math.radians(deg)
        x += math.cos(rad) * w
        y += math.sin(rad) * w
        total_w += w
    if total_w <= 0 or (abs(x) < 1e-9 and abs(y) < 1e-9):
        return None
    return round((math.degrees(math.atan2(y, x)) + 360) % 360)


def _weighted_vote(pairs: Iterable[tuple[float, float]]) -> int | None:
    tally: dict[int, float] = {}
    for code, w in pairs:
        tally[int(code)] = tally.get(int(code), 0.0) + w
    if not tally:
        return None
    return max(tally.items(), key=lambda kv: (kv[1], kv[0]))[0]


def _round(var: str, v: float | None):
    if v is None:
        return None
    if var in ("relative_humidity_2m", "cloud_cover", "visibility", "cape"):
        return round(v)
    return round(v, 2 if var in ("precipitation", "precipitation_sum", "lifted_index") else 1)


def blend_section(
    section: dict,
    variables: Iterable[str],
    weights: dict[str, float],
    *,
    single: bool = False,
    agreement_threshold: float = 0.1,
    precip_var: str = "precipitation",
) -> dict:
    """Blend one Open-Meteo section (``hourly`` / ``daily``) across members.

    ``section`` holds model-suffixed arrays (``temperature_2m_ecmwf_ifs`` …)
    plus the shared ``time`` axis. Returns an unsuffixed section in the
    canonical WeatherData shape.
    """
    times = list(section.get("time") or [])
    n = len(times)
    members = order_members(weights)
    out: dict = {"time": times}

    for var in variables:
        if var == "time":
            continue
        series: list = []
        for i in range(n):
            if var in _FIRST_FIELDS:
                value = None
                for m in members:
                    v = _member_value(section, var, m, i, single)
                    if v is not None:
                        value = v
                        break
                series.append(value)
                continue

            pairs = []
            for m in members:
                v = _num(_member_value(section, var, m, i, single))
                if v is not None:
                    pairs.append((v, weights[m]))

            if var in _DIRECTION_FIELDS:
                series.append(_circular_mean(pairs))
            elif var in _CODE_FIELDS:
                series.append(_weighted_vote(pairs))
            elif var in _PROB_FIELDS:
                ensemble = _weighted_mean(pairs)
                agree_pairs = []
                for m in members:
                    p = _num(_member_value(section, precip_var, m, i, single))
                    if p is not None:
                        agree_pairs.append((1.0 if p >= agreement_threshold else 0.0, weights[m]))
                agreement = _weighted_mean(agree_pairs)
                if ensemble is None and agreement is None:
                    series.append(None)
                elif ensemble is None:
                    series.append(round(agreement * 100))  # type: ignore[operator]
                elif agreement is None:
                    series.append(round(ensemble))
                else:
                    series.append(round(0.5 * ensemble + 0.5 * agreement * 100))
            else:
                series.append(_round(var, _weighted_mean(pairs)))
        out[var] = series
    return out


def blend_payload(raw: dict, weights: dict[str, float], *, single: bool = False) -> dict:
    """Turn a multi-model Open-Meteo response into one canonical payload.

    Returns ``{"current", "hourly", "daily", "current_units"}`` plus
    ``utc_offset_seconds`` when Open-Meteo reported it. Intermediate fields
    (cape/lifted_index/dew point/ET₀) are KEPT here — the caller derives
    insights from them and strips them before caching.
    """
    from ._insights import current_hour_index

    hourly = blend_section(raw.get("hourly") or {}, HOURLY_VARS.split(","), weights, single=single)
    daily = blend_section(
        raw.get("daily") or {},
        DAILY_VARS.split(","),
        weights,
        single=single,
        agreement_threshold=1.0,
        precip_var="precipitation_sum",
    )

    current = dict(raw.get("current") or {})
    current.pop("interval", None)
    idx = current_hour_index(hourly, current.get("time"))
    for var in CURRENT_VARS.split(","):
        if current.get(var) is None:
            arr = hourly.get(var) or []
            if idx < len(arr) and arr[idx] is not None:
                current[var] = arr[idx]

    out = {
        "current": current,
        "hourly": hourly,
        "daily": daily,
        "current_units": raw.get("current_units") or {},
    }
    offset = raw.get("utc_offset_seconds")
    if isinstance(offset, (int, float)) and not isinstance(offset, bool):
        out["utc_offset_seconds"] = int(offset)
    return out


def members_with_data(raw: dict, models: Iterable[str]) -> list[str]:
    """Members whose suffixed hourly temperature has at least one value."""
    hourly = raw.get("hourly") or {}
    present = []
    for m in models:
        arr = hourly.get(f"temperature_2m_{m}") or []
        if any(v is not None for v in arr):
            present.append(m)
    return present


def parse_minutely_any(raw: dict, models: Iterable[str], steps: int = 4) -> dict | None:
    """Nowcast from ``minutely_15`` — unsuffixed or the first member's.

    Keeps ``steps`` 15-minute steps; the serving path trims them to the next
    hour (``_weather._fresh_minutely``)."""
    minutely = raw.get("minutely_15") or {}
    times = minutely.get("time") or []
    if not times:
        return None
    precip = minutely.get("precipitation")
    if precip is None:
        for m in models:
            precip = minutely.get(f"precipitation_{m}")
            if precip is not None and any(v is not None for v in precip):
                break
    precip = precip or []
    return {
        "time": list(times[:steps]),
        "precipitation": [p if p is not None else 0 for p in precip[:steps]],
    }


def format_weights(region: str, weights: dict[str, float]) -> str:
    """``X-Weather-Blend`` header value, e.g. ``southern-africa; ecmwf_ifs=0.41,…``."""
    total = sum(weights.values()) or 1.0
    parts = ",".join(f"{m}={weights[m] / total:.2f}" for m in order_members(weights))
    return f"{region}; {parts}"
