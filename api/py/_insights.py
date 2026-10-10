"""
Derived weather insights — computed from global-model data, no Tomorrow.io.

Tomorrow.io used to be the only source of the extended ``insights`` block
(GDD, heat stress, thunderstorm probability, UV health concern, cloud base /
ceiling, moon phase, …) that the suitability rules and ActivityInsights read.
Its free tier cannot carry the baseline (issue #246), so every field it
supplied is now DERIVED here from the Open-Meteo baseline, and Tomorrow.io
is merged on top only as an optional enrichment (``_enrichment.py``).

Mirror: ``synthesizeOpenMeteoInsights`` in ``src/lib/weather.ts`` (used on
the TS direct-Open-Meteo fallback path). Keep the two in sync — the
formulas below are pinned by tests on both sides.

Units follow the ``WeatherInsights`` type: °C, km/h, km (visibility, cloud
base/ceiling), mm (evapotranspiration), % (thunderstorm probability).
"""

from __future__ import annotations

import math
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Physical helpers
# ---------------------------------------------------------------------------

#: Magnus-formula coefficients (Alduchov & Eskridge 1996), valid -40..50 °C.
_MAGNUS_A = 17.625
_MAGNUS_B = 243.04


def dew_point_c(temp_c: float | None, rh_pct: float | None) -> float | None:
    """Dew point (°C) from air temperature and relative humidity (Magnus)."""
    if temp_c is None or rh_pct is None:
        return None
    try:
        rh = max(1.0, min(100.0, float(rh_pct)))
        t = float(temp_c)
    except (TypeError, ValueError):
        return None
    gamma = math.log(rh / 100.0) + (_MAGNUS_A * t) / (_MAGNUS_B + t)
    return round((_MAGNUS_B * gamma) / (_MAGNUS_A - gamma), 1)


def heat_index_c(temp_c: float | None, rh_pct: float | None) -> float | None:
    """NOAA heat index (Rothfusz regression) in °C.

    Below 27 °C (80 °F) the regression is not valid and the heat index is the
    air temperature — the same convention NOAA uses. This is the heat-stress
    approximation fed to the ``heatStressIndex`` suitability field (rules
    trigger around 28+).
    """
    if temp_c is None or rh_pct is None:
        return None
    try:
        t_c = float(temp_c)
        rh = max(0.0, min(100.0, float(rh_pct)))
    except (TypeError, ValueError):
        return None
    if t_c < 27.0:
        return round(t_c, 1)
    t = t_c * 9 / 5 + 32
    hi = (
        -42.379
        + 2.04901523 * t
        + 10.14333127 * rh
        - 0.22475541 * t * rh
        - 6.83783e-3 * t * t
        - 5.481717e-2 * rh * rh
        + 1.22874e-3 * t * t * rh
        + 8.5282e-4 * t * rh * rh
        - 1.99e-6 * t * t * rh * rh
    )
    # NOAA adjustments for very dry / very humid conditions.
    if rh < 13 and 80 <= t <= 112:
        hi -= ((13 - rh) / 4) * math.sqrt((17 - abs(t - 95)) / 17)
    elif rh > 85 and 80 <= t <= 87:
        hi += ((rh - 85) / 10) * ((87 - t) / 5)
    return round((hi - 32) * 5 / 9, 1)


def growing_degree_days(tmax: float | None, tmin: float | None, base: float, cap: float) -> float | None:
    """Daily GDD with base and upper-cap clamping (the standard maize method).

    Both extremes are clamped into [base, cap] before averaging, matching how
    Tomorrow.io defines ``gdd10To30`` etc.
    """
    if tmax is None or tmin is None:
        return None
    try:
        hi = min(max(float(tmax), base), cap)
        lo = min(max(float(tmin), base), cap)
    except (TypeError, ValueError):
        return None
    return round(max(0.0, (hi + lo) / 2 - base), 1)


#: (insights key, base °C, cap °C) — the four GDD fields the rules can read.
GDD_DEFINITIONS: tuple[tuple[str, float, float], ...] = (
    ("gdd10To30", 10.0, 30.0),  # maize, soybean
    ("gdd10To31", 10.0, 31.0),  # sunflower
    ("gdd08To30", 8.0, 30.0),  # sorghum, green gram
    ("gdd03To25", 3.0, 25.0),  # potatoes
)


def wmo_hazards(code: int | None) -> tuple[int, int]:
    """``(thunderstormProbability, precipitationType)`` implied by a WMO code.

    Mirror of ``wmoToInsightHazards`` in src/lib/weather.ts.
    precipitationType: 0 none, 1 rain, 2 snow, 3 freezing rain/drizzle.
    """
    try:
        c = int(code) if code is not None else 0
    except (TypeError, ValueError):
        c = 0
    if c >= 99:
        thunder = 95
    elif c >= 96:
        thunder = 85
    elif c >= 95:
        thunder = 70
    else:
        thunder = 0

    if 71 <= c <= 77 or 85 <= c <= 86:
        ptype = 2
    elif c in (56, 57, 66, 67):
        ptype = 3
    elif c >= 51:
        ptype = 1
    else:
        ptype = 0
    return thunder, ptype


def convective_proxy(cape: float | None, lifted_index: float | None) -> int:
    """Thunderstorm potential (%) from CAPE (J/kg) and lifted index (K).

    A deliberately simple, documented proxy — NOT a calibrated probability:

    ==========================  ======
    condition                   score
    ==========================  ======
    CAPE ≥ 2500 or LI ≤ -6      60
    CAPE ≥ 1000 or LI ≤ -3      40
    CAPE ≥ 500  or LI ≤ -1      20
    otherwise                   0
    ==========================  ======

    Either signal alone can raise the score (many global members publish
    CAPE but not LI).
    """
    c = cape if isinstance(cape, (int, float)) else None
    li = lifted_index if isinstance(lifted_index, (int, float)) else None
    if (c is not None and c >= 2500) or (li is not None and li <= -6):
        return 60
    if (c is not None and c >= 1000) or (li is not None and li <= -3):
        return 40
    if (c is not None and c >= 500) or (li is not None and li <= -1):
        return 20
    return 0


#: A reference new moon (2000-01-06 18:14 UTC) and the mean synodic month.
_NEW_MOON_REF = datetime(2000, 1, 6, 18, 14, tzinfo=timezone.utc)
_SYNODIC_DAYS = 29.530588853


def moon_phase(when: datetime | None = None) -> int:
    """Moon phase on Tomorrow.io's 0–7 scale (0 new … 4 full … 7 waning crescent)."""
    when = when or datetime.now(timezone.utc)
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    age = ((when - _NEW_MOON_REF).total_seconds() / 86400.0) % _SYNODIC_DAYS
    return int(round(age / _SYNODIC_DAYS * 8)) % 8


def cloud_base_km(temp_c: float | None, dew_c: float | None, cloud_cover: float | None) -> float | None:
    """Convective cloud base (km AGL) ≈ LCL = 125 m × (T − Td).

    ``None`` when the sky is essentially clear (< 10 % cover) — Tomorrow.io
    also reports no cloud base without cloud.
    """
    if temp_c is None or dew_c is None or cloud_cover is None:
        return None
    try:
        if float(cloud_cover) < 10:
            return None
        spread = max(0.0, float(temp_c) - float(dew_c))
    except (TypeError, ValueError):
        return None
    return round(spread * 0.125, 2)


# ---------------------------------------------------------------------------
# Index helpers
# ---------------------------------------------------------------------------


def current_hour_index(hourly: dict, current_time: str | None) -> int:
    """Index of the current hour in ``hourly.time`` (prefix match on YYYY-MM-DDTHH).

    Falls back to 0 when the time is missing or not found.
    """
    times = hourly.get("time") or []
    if not current_time or not times:
        return 0
    prefix = str(current_time)[:13]
    for i, t in enumerate(times):
        if str(t)[:13] == prefix:
            return i
    return 0


def _at(arr, i):
    try:
        v = arr[i]
    except (IndexError, TypeError, KeyError):
        return None
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


# ---------------------------------------------------------------------------
# Main derivation
# ---------------------------------------------------------------------------

#: Hours ahead scanned for convective potential.
CONVECTIVE_WINDOW_H = 6


def derive_insights(data: dict, now: datetime | None = None) -> dict:
    """Build a ``WeatherInsights`` dict from a baseline ``WeatherData`` payload.

    Reads optional intermediate fields when present (``hourly.cape``,
    ``hourly.lifted_index``, ``hourly.dew_point_2m``,
    ``daily.et0_fao_evapotranspiration``, ``hourly.precip_agreement``) — the
    fetchers request them and strip them afterwards so the cached document
    shape stays unchanged.
    """
    current = data.get("current") or {}
    hourly = data.get("hourly") or {}
    daily = data.get("daily") or {}

    idx = current_hour_index(hourly, current.get("time"))
    temp = current.get("temperature_2m")
    rh = current.get("relative_humidity_2m")

    out: dict = {}

    def put(key, value):
        if value is not None:
            out[key] = value

    put("windSpeed", current.get("wind_speed_10m"))
    put("windGust", current.get("wind_gusts_10m"))

    # Visibility: Open-Meteo reports metres, the insights field is km (the
    # suitability thresholds are 1/2/3/5 km).
    vis_m = _at(hourly.get("visibility"), idx)
    if vis_m is not None:
        put("visibility", round(vis_m / 1000.0, 2))

    dew = _at(hourly.get("dew_point_2m"), idx)
    if dew is None:
        dew = dew_point_c(temp, rh)
    put("dewPoint", dew)

    put("heatStressIndex", heat_index_c(temp, rh))

    uv = current.get("uv_index")
    if uv is None:
        uv = _at(hourly.get("uv_index"), idx)
    put("uvHealthConcern", uv)

    code_thunder, ptype = wmo_hazards(current.get("weather_code"))
    put("precipitationType", ptype)

    # Thunderstorm: max of the WMO-code value and the convective proxy over
    # the next few hours, damped when models don't agree on any rain.
    cape_arr = hourly.get("cape") or []
    li_arr = hourly.get("lifted_index") or []
    code_arr = hourly.get("weather_code") or []
    pp_arr = hourly.get("precipitation_probability") or []
    convective = 0
    max_pp = 0.0
    for i in range(idx, idx + CONVECTIVE_WINDOW_H):
        convective = max(convective, convective_proxy(_at(cape_arr, i), _at(li_arr, i)))
        hourly_code = _at(code_arr, i)
        if hourly_code is not None:
            code_thunder = max(code_thunder, wmo_hazards(int(hourly_code))[0])
        pp = _at(pp_arr, i)
        if pp is not None:
            max_pp = max(max_pp, float(pp))
    if pp_arr and max_pp < 20:
        convective //= 2
    put("thunderstormProbability", max(code_thunder, convective))

    tmax = _at(daily.get("temperature_2m_max"), 0)
    tmin = _at(daily.get("temperature_2m_min"), 0)
    for key, base, cap in GDD_DEFINITIONS:
        put(key, growing_degree_days(tmax, tmin, base, cap))

    put("evapotranspiration", _at(daily.get("et0_fao_evapotranspiration"), 0))

    put("moonPhase", moon_phase(now))

    cover = current.get("cloud_cover")
    base_km = cloud_base_km(temp, dew, cover)
    if base_km is not None:
        out["cloudBase"] = base_km
        # Ceiling = base of a layer covering more than half the sky.
        out["cloudCeiling"] = base_km if (cover or 0) >= 50 else None

    return out


#: Intermediate fields requested only to derive insights; stripped before the
#: payload is cached so the WeatherData shape is unchanged (issue #101).
INTERMEDIATE_HOURLY = ("cape", "lifted_index", "dew_point_2m")
INTERMEDIATE_DAILY = ("et0_fao_evapotranspiration",)


def strip_intermediate(data: dict) -> dict:
    """Return a shallow copy of ``data`` without the intermediate fields."""
    out = dict(data)
    hourly = data.get("hourly")
    if isinstance(hourly, dict):
        out["hourly"] = {k: v for k, v in hourly.items() if k not in INTERMEDIATE_HOURLY}
    daily = data.get("daily")
    if isinstance(daily, dict):
        out["daily"] = {k: v for k, v in daily.items() if k not in INTERMEDIATE_DAILY}
    return out
