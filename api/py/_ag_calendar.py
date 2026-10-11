"""
Agriculture calendars for a place: crop planting, growing and harvest windows.

The interface is :class:`AgricultureCalendarSource`. Each source returns an
:class:`AgCalendar` (per-crop windows plus provenance) or ``None``, and
:func:`calendar_for` tries them in order:

1. :class:`GeoglamCalendarSource`: the GEOGLAM Crop Monitor Sub-National Crop
   Calendars (Crop Monitor for Early Warning, v1.3, Becker-Reshef et al.,
   doi:10.5281/zenodo.15850408, CC BY 4.0). 86 countries, sub-national
   regions built from FAO GAUL admin-1 units, crops wheat, maize, rice,
   sorghum, millet, beans and teff, five stages as day-of-year starts. Shipped
   as a compact table (``data/geoglam_cm4ew_v1_3.json.gz``, built by
   ``scripts/build_geoglam_calendars.py``): simplified region outlines for
   point-in-region lookup and the stage starts.
2. :class:`DerivedCalendarSource`: where no calendar covers the point, the
   likely growing window is derived from the climate normals (months with a
   mean of 10 °C or more outside the tropics; months with 60 mm or more of
   normal rain inside them). It is marked ``method: "derived"`` and **names no
   crops**: a derived default must never be stated as a local fact.

Reference calendars live here, in code, never in a database. Only the windows
that apply to a place are stored, in that place's knowledge document.

FAO's crop calendar is not used: FAO content is licensed for non-commercial
products and services only (fao.org/contact-us/terms, checked 2026-10-11).
"""

from __future__ import annotations

import datetime as _dt
import gzip
import json
import logging
import re
from pathlib import Path
from typing import Optional, Protocol

from pydantic import BaseModel

logger = logging.getLogger(__name__)

DATA_FILE = Path(__file__).resolve().parent / "data" / "geoglam_cm4ew_v1_3.json.gz"

GEOGLAM_SOURCE = "GEOGLAM Crop Monitor Sub-National Crop Calendars (CM4EW) v1.3"
GEOGLAM_LICENCE = "CC-BY-4.0"
GEOGLAM_ATTRIBUTION = (
    "Becker-Reshef, I., Barker, B. et al., GEOGLAM Crop Monitor Sub-National Crop "
    "Calendars, v1.3 (2025), doi:10.5281/zenodo.15850408"
)
GEOGLAM_URL = "https://doi.org/10.5281/zenodo.15850408"

#: A point outside every region outline (a border gap left by simplification,
#: or a city carved out of its province) joins the nearest region of its
#: country within this distance, measured to the region's bounding box.
NEAREST_REGION_MAX_DEG = 0.5

#: Derived-default thresholds.
GROWING_MEAN_TEMP_C = 10.0
RAINY_MONTH_MM = 60.0
DRY_MONTH_MM = 30.0
COLD_MONTH_MEAN_C = 5.0
TROPICS_LAT = 23.44

#: GEOGLAM country names (as spelt in the dataset) → ISO 3166-1 alpha-2.
GEOGLAM_COUNTRY_ISO: dict[str, str] = {
    "Afghanistan": "AF", "Algeria": "DZ", "Angola": "AO", "Bangladesh": "BD",
    "Benin": "BJ", "Bolivia": "BO", "Botswana": "BW", "Brunei": "BN",
    "Burkina Faso": "BF", "Burundi": "BI", "Cambodia": "KH", "Cameroon": "CM",
    "Cape Verde": "CV", "Central African Republic": "CF", "Chad": "TD",
    "Chile": "CL", "Colombia": "CO", "Congo": "CG", "Cote d'Ivoire": "CI",
    "Cuba": "CU", "Dem People's Rep of Korea": "KP",
    "Democratic Republic of the Congo": "CD", "Djibouti": "DJ", "Egypt": "EG",
    "El Salvador": "SV", "Equador": "EC", "Equatorial Guinea": "GQ",
    "Eritrea": "ER", "Ethiopia": "ET", "Gambia": "GM", "Ghana": "GH",
    "Guatemala": "GT", "Guinea": "GN", "Guinea-Bissau": "GW", "Haiti": "HT",
    "Honduras": "HN", "Indonesia": "ID", "Iran  (Islamic Republic of)": "IR",
    "Iraq": "IQ", "Kazakhstan": "KZ", "Kenya": "KE", "Kyrgyzstan": "KG",
    "Lao People's Democratic Republic": "LA", "Lebanon": "LB", "Lesotho": "LS",
    "Liberia": "LR", "Libya": "LY", "Madagascar": "MG", "Malawi": "MW",
    "Malaysia": "MY", "Mali": "ML", "Mauritania": "MR", "Mongolia": "MN",
    "Morocco": "MA", "Mozambique": "MZ", "Myanmar": "MM", "Namibia": "NA",
    "Nepal": "NP", "Nicaragua": "NI", "Niger": "NE", "Nigeria": "NG",
    "Pakistan": "PK", "Peru": "PE", "Philippines": "PH", "Rwanda": "RW",
    "Senegal": "SN", "Sierra Leone": "SL", "Somalia": "SO",
    "South Africa": "ZA", "South Sudan": "SS", "Sri Lanka": "LK",
    "Sudan": "SD", "Syrian Arab Republic": "SY", "Tajikistan": "TJ",
    "Thailand": "TH", "Togo": "TG", "Tunisia": "TN", "Turkmenistan": "TM",
    "Uganda": "UG", "United Republic of Tanzania": "TZ", "Uzbekistan": "UZ",
    "Vietnam": "VN", "Yemen": "YE", "Zambia": "ZM", "Zimbabwe": "ZW",
    "eSwatini": "SZ",
}

#: Season names for numbered crops, from the dataset's ReadMe
#: ("Multiple Crop Season Notes"), keyed by ISO code then GEOGLAM crop.
SEASON_NAMES: dict[str, dict[str, str]] = {
    "AF": {"Wheat 1": "Winter-planted", "Wheat 2": "Spring-planted"},
    "BD": {"Maize 1": "Winter (Kharif)", "Maize 2": "Summer (Rabi)",
           "Rice 1": "Boro", "Rice 2": "Aman", "Rice 3": "Aus"},
    "BJ": {"Maize 1": "Main season", "Maize 2": "Second season"},
    "BI": {"Maize 1": "Season B", "Maize 2": "Season A", "Rice 1": "Season B"},
    "KH": {"Rice 1": "Wet season", "Rice 2": "Dry season"},
    "CM": {"Maize 1": "Main season", "Maize 2": "Second season"},
    "CI": {"Maize 1": "Main season", "Maize 2": "Second season"},
    "CD": {"Maize 1": "Main season", "Maize 2": "Second season"},
    "EG": {"Rice 1": "Summer-planted", "Rice 2": "Nili season (Nile flood)"},
    "SV": {"Beans 1": "Primera", "Beans 2": "Postrera", "Maize 1": "Primera", "Maize 2": "Segunda"},
    "ET": {"Maize 1": "Meher", "Maize 2": "Belg"},
    "GH": {"Maize 1": "Main season", "Maize 2": "Second season"},
    "GT": {"Beans 1": "Primera", "Beans 2": "Postrera", "Beans 3": "Apante",
           "Maize 1": "Primera", "Maize 2": "Segunda"},
    "HT": {"Beans 1": "Printemps", "Beans 2": "Été", "Beans 3": "Hiver",
           "Maize 1": "Printemps", "Maize 2": "Été"},
    "HN": {"Beans 1": "Primera", "Beans 2": "Postrera", "Maize 1": "Primera", "Maize 2": "Segunda"},
    "ID": {"Rice 1": "Wet season", "Rice 2": "Dry season"},
    "KZ": {"Wheat 1": "Winter-planted", "Wheat 2": "Spring-planted"},
    "KE": {"Maize 1": "Long rains", "Maize 2": "Short rains"},
    "KG": {"Wheat 1": "Winter-planted", "Wheat 2": "Spring-planted"},
    "LA": {"Rice 1": "Wet season", "Rice 2": "Dry season"},
    "MR": {"Rice 1": "Main season", "Rice 2": "Off-season"},
    "MZ": {"Maize 1": "Main season", "Maize 2": "Second season"},
    "MM": {"Rice 1": "Wet season", "Rice 2": "Dry season"},
    "NI": {"Beans 1": "Primera", "Beans 2": "Postrera", "Beans 3": "Apante",
           "Maize 1": "Primera", "Maize 2": "Segunda"},
    "NG": {"Maize 1": "Main season", "Maize 2": "Short season",
           "Rice 1": "Main season", "Rice 2": "Off-season"},
    "PK": {"Rice 1": "Kharif (summer)", "Wheat 1": "Rabi"},
    "PH": {"Rice 1": "Wet season", "Rice 2": "Dry season"},
    "RW": {"Maize 1": "Season B", "Maize 2": "Season A"},
    "SO": {"Maize 1": "Gu", "Maize 2": "Deyr", "Sorghum 1": "Gu", "Sorghum 2": "Deyr"},
    "SS": {"Maize 1": "First season", "Millet 1": "First season", "Sorghum 1": "First season"},
    "LK": {"Maize 1": "Maha", "Maize 2": "Yala", "Rice 1": "Maha", "Rice 2": "Yala"},
    "TJ": {"Wheat 1": "Winter-planted", "Wheat 2": "Spring-planted"},
    "TH": {"Rice 1": "Wet season", "Rice 2": "Dry season"},
    "TG": {"Maize 1": "Main season", "Maize 2": "Second season"},
    "UG": {"Maize 1": "First season", "Maize 2": "Second season"},
    "TZ": {"Maize 1": "Masika / Msimu", "Maize 2": "Vuli", "Millet 1": "Masika / Msimu",
           "Rice 1": "Masika / Msimu", "Sorghum 1": "Masika / Msimu", "Sorghum 2": "Vuli",
           "Wheat 1": "Masika / Msimu"},
    "VN": {"Rice 1": "Other wet season", "Rice 2": "Dry season (winter-spring)",
           "Rice 3": "Main wet season"},
}

#: Stage keys in phenological order, with their labels.
STAGES: tuple[tuple[str, str], ...] = (
    ("planting", "Planting to early vegetative"),
    ("vegetative", "Vegetative to reproductive"),
    ("harvest", "Ripening through harvest"),
    ("endOfSeason", "End of harvest"),
    ("outOfSeason", "Out of season"),
)
STAGE_LABELS = dict(STAGES)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class CropStages(BaseModel):
    """Day-of-year (1–365) on which each GEOGLAM stage starts. ``outOfSeason``
    is ``None`` when the fields are never idle in that region."""

    planting: int
    vegetative: int
    harvest: int
    endOfSeason: int
    outOfSeason: Optional[int] = None


class CropWindow(BaseModel):
    crop: str  # machine id: "maize", "rice", "winter-wheat"
    cropLabel: str  # "Maize", "Winter wheat"
    season: Optional[str] = None  # "Long rains", "Wet season"
    stages: CropStages


class DerivedGrowingWindow(BaseModel):
    """A growing window derived from the normals. Names no crops."""

    months: list[int]
    basis: str
    method: str = "derived"


class GrazingNotes(BaseModel):
    """Derived from the normals; marked derived wherever it is shown."""

    dryMonths: list[int] = []
    coldMonths: list[int] = []
    note: Optional[str] = None
    method: str = "derived"


class AgCalendar(BaseModel):
    source: str
    licence: Optional[str] = None
    attribution: Optional[str] = None
    url: Optional[str] = None
    method: str  # "seed" (a published calendar) | "derived"
    country: Optional[str] = None
    region: Optional[str] = None
    crops: list[CropWindow] = []
    derived: Optional[DerivedGrowingWindow] = None


class CropPhase(BaseModel):
    crop: str
    cropLabel: str
    season: Optional[str] = None
    phase: str
    phaseLabel: str
    nextPhase: str
    nextPhaseLabel: str
    nextPhaseOn: str  # ISO date


class AgricultureCalendarSource(Protocol):
    """Anything that can say which crop windows apply at a point."""

    name: str

    def calendar_for(
        self,
        lat: float,
        lon: float,
        country: Optional[str],
        admin1: Optional[str] = None,
        monthly_normals: Optional[list[dict]] = None,
    ) -> Optional[AgCalendar]: ...


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------


def point_in_rings(lon: float, lat: float, rings: list[list[list[float]]]) -> bool:
    """Even-odd ray casting over every ring (holes included)."""
    inside = False
    for ring in rings:
        n = len(ring)
        j = n - 1
        for i in range(n):
            xi, yi = ring[i][0], ring[i][1]
            xj, yj = ring[j][0], ring[j][1]
            if (yi > lat) != (yj > lat):
                x_cross = (xj - xi) * (lat - yi) / (yj - yi) + xi
                if lon < x_cross:
                    inside = not inside
            j = i
    return inside


def _bbox_distance(lon: float, lat: float, bbox: list[float]) -> float:
    dx = max(bbox[0] - lon, 0.0, lon - bbox[2])
    dy = max(bbox[1] - lat, 0.0, lat - bbox[3])
    return (dx * dx + dy * dy) ** 0.5


# ---------------------------------------------------------------------------
# GEOGLAM
# ---------------------------------------------------------------------------


_CROP_RE = re.compile(r"^(?P<base>.+?)(?:\s+(?P<n>\d))?$")


def _crop_ids(geoglam_crop: str) -> tuple[str, str]:
    """``"Maize 1"`` → (``"maize"``, ``"Maize"``); ``"Winter Wheat"`` → (``"winter-wheat"``, ``"Winter wheat"``)."""
    m = _CROP_RE.match(geoglam_crop.strip())
    base = (m.group("base") if m else geoglam_crop).strip()
    label = base[:1].upper() + base[1:].lower()
    return re.sub(r"[^a-z0-9]+", "-", base.lower()).strip("-"), label


class GeoglamCalendarSource:
    name = "geoglam-cm4ew-v1.3"

    def __init__(self, path: Path = DATA_FILE):
        self._path = path
        self._loaded = False
        self._regions: dict[str, list[dict]] = {}
        self._calendars: dict[str, list[dict]] = {}

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            data = json.loads(gzip.decompress(self._path.read_bytes()))
        except Exception as exc:  # noqa: BLE001 — a missing table degrades to the derived default
            logger.warning("GEOGLAM calendar table unavailable: %s", exc)
            return
        for region in data.get("regions", []):
            iso = GEOGLAM_COUNTRY_ISO.get(region.get("country", ""))
            if iso:
                self._regions.setdefault(iso, []).append(region)
        for cal in data.get("calendars", []):
            self._calendars.setdefault(cal["key"], []).append(cal)

    def countries(self) -> set[str]:
        self._load()
        return set(self._regions)

    def region_for(self, lat: float, lon: float, country: Optional[str]) -> Optional[dict]:
        self._load()
        candidates = self._regions.get((country or "").upper(), [])
        if not candidates:
            return None
        for region in candidates:
            b = region["bbox"]
            if b[0] <= lon <= b[2] and b[1] <= lat <= b[3] and point_in_rings(lon, lat, region["rings"]):
                return region
        best = min(candidates, key=lambda r: _bbox_distance(lon, lat, r["bbox"]))
        if _bbox_distance(lon, lat, best["bbox"]) <= NEAREST_REGION_MAX_DEG:
            return best
        return None

    def calendar_for(self, lat, lon, country, admin1=None, monthly_normals=None) -> Optional[AgCalendar]:
        region = self.region_for(lat, lon, country)
        if not region:
            return None
        iso = (country or "").upper()
        key = f"{region['country']}|{region['region']}"
        crops: list[CropWindow] = []
        for row in sorted(self._calendars.get(key, []), key=lambda r: r["crop"]):
            p, v, h, e, o = (row["doy"] + [0, 0, 0, 0, 0])[:5]
            if not (p and v and h and e):
                continue
            crop_id, label = _crop_ids(row["crop"])
            season = SEASON_NAMES.get(iso, {}).get(row["crop"])
            number = _CROP_RE.match(row["crop"].strip()).group("n")
            if season is None and number:
                # The dataset numbers seasons by size: 1 is the largest.
                season = "Main season" if number == "1" else f"Season {number}"
            crops.append(CropWindow(
                crop=crop_id,
                cropLabel=label,
                season=season,
                stages=CropStages(planting=p, vegetative=v, harvest=h, endOfSeason=e,
                                  outOfSeason=o or None),
            ))
        if not crops:
            return None
        return AgCalendar(
            source=GEOGLAM_SOURCE,
            licence=GEOGLAM_LICENCE,
            attribution=GEOGLAM_ATTRIBUTION,
            url=GEOGLAM_URL,
            method="seed",
            country=iso,
            region=region["region"],
            crops=crops,
        )


# ---------------------------------------------------------------------------
# Derived default
# ---------------------------------------------------------------------------


def _months_where(monthly: list[dict], key: str, test) -> list[int]:
    out = []
    for row in monthly or []:
        value = row.get(key)
        if value is not None and test(float(value)):
            out.append(int(row["month"]))
    return out


def derived_growing_window(lat: float, monthly: Optional[list[dict]]) -> Optional[DerivedGrowingWindow]:
    """The likely growing window from the normals, or ``None`` without them."""
    if not monthly:
        return None
    if abs(lat) < TROPICS_LAT:
        months = _months_where(monthly, "precipMm", lambda v: v >= RAINY_MONTH_MM)
        basis = f"months with {RAINY_MONTH_MM:.0f} mm or more of normal rainfall"
    else:
        months = _months_where(monthly, "meanTempC", lambda v: v >= GROWING_MEAN_TEMP_C)
        basis = f"months with a mean temperature of {GROWING_MEAN_TEMP_C:.0f} °C or more"
    return DerivedGrowingWindow(months=months, basis=basis)


def grazing_notes(lat: float, monthly: Optional[list[dict]]) -> Optional[GrazingNotes]:
    """Dry and cold months from the normals, for livestock and grazing context."""
    if not monthly:
        return None
    dry = _months_where(monthly, "precipMm", lambda v: v < DRY_MONTH_MM)
    cold = _months_where(monthly, "meanTempC", lambda v: v < COLD_MONTH_MEAN_C)
    parts = []
    if dry and len(dry) < 12:
        parts.append(f"normal rain under {DRY_MONTH_MM:.0f} mm in {len(dry)} months, when forage and surface water are usually scarcer")
    if cold:
        parts.append(f"mean temperature under {COLD_MONTH_MEAN_C:.0f} °C in {len(cold)} months, with little pasture growth")
    return GrazingNotes(dryMonths=dry if len(dry) < 12 else [], coldMonths=cold,
                        note="; ".join(parts) or None)


class DerivedCalendarSource:
    name = "derived-from-normals"

    def calendar_for(self, lat, lon, country, admin1=None, monthly_normals=None) -> Optional[AgCalendar]:
        window = derived_growing_window(lat, monthly_normals)
        if window is None:
            return None
        return AgCalendar(
            source="Derived from ERA5 1991–2020 climate normals",
            licence="CC-BY-4.0",
            attribution="Copernicus Climate Change Service ERA5, via Open-Meteo",
            url="https://open-meteo.com/en/docs/historical-weather-api",
            method="derived",
            country=(country or "").upper() or None,
            derived=window,
        )


GEOGLAM = GeoglamCalendarSource()
DEFAULT_SOURCES: tuple[AgricultureCalendarSource, ...] = (GEOGLAM, DerivedCalendarSource())


def calendar_for(
    lat: float,
    lon: float,
    country: Optional[str],
    admin1: Optional[str] = None,
    monthly_normals: Optional[list[dict]] = None,
    sources: tuple[AgricultureCalendarSource, ...] = DEFAULT_SOURCES,
) -> Optional[AgCalendar]:
    """The first source that knows this point wins. A published calendar also
    carries the derived growing window when normals are available."""
    for source in sources:
        try:
            cal = source.calendar_for(lat, lon, country, admin1, monthly_normals)
        except Exception as exc:  # noqa: BLE001 — one bad source must not stop the chain
            logger.warning("calendar source %s failed: %s", getattr(source, "name", source), exc)
            continue
        if cal:
            if cal.derived is None:
                cal.derived = derived_growing_window(lat, monthly_normals)
            return cal
    return None


# ---------------------------------------------------------------------------
# Current phase (computed at read time, never stored)
# ---------------------------------------------------------------------------


def _doy(day: _dt.date) -> int:
    """Day of year on GEOGLAM's 365-day scale (Dec 31 of a leap year → 365)."""
    return min(day.timetuple().tm_yday, 365)


def _date_for_doy(today: _dt.date, doy: int) -> _dt.date:
    """The next date on or after ``today`` whose day of year is ``doy``."""
    for year in (today.year, today.year + 1):
        candidate = _dt.date(year, 1, 1) + _dt.timedelta(days=doy - 1)
        if candidate >= today:
            return candidate
    return _dt.date(today.year + 1, 1, 1) + _dt.timedelta(days=doy - 1)


def crop_phase(window: CropWindow, today: _dt.date) -> CropPhase:
    """The stage ``today`` falls in, and when the next one starts."""
    stages = [(key, getattr(window.stages, key)) for key, _ in STAGES]
    stages = [(k, s) for k, s in stages if s]
    doy = _doy(today)
    current = stages[-1]
    for i, (key, start) in enumerate(stages):
        nxt = stages[(i + 1) % len(stages)][1]
        span = (nxt - start) % 365 or 365
        if (doy - start) % 365 < span:
            current = (key, start)
            break
    idx = [k for k, _ in stages].index(current[0])
    next_key, next_start = stages[(idx + 1) % len(stages)]
    return CropPhase(
        crop=window.crop,
        cropLabel=window.cropLabel,
        season=window.season,
        phase=current[0],
        phaseLabel=STAGE_LABELS[current[0]],
        nextPhase=next_key,
        nextPhaseLabel=STAGE_LABELS[next_key],
        nextPhaseOn=_date_for_doy(today + _dt.timedelta(days=1), next_start).isoformat(),
    )
