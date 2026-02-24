"""Device profile endpoints — Phase 1."""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from pymongo.errors import DuplicateKeyError

from ._db import device_profiles_collection

router = APIRouter()

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

VALID_THEMES = {"light", "dark", "system"}
MAX_ACTIVITIES = 30
MAX_SAVED_LOCATIONS = 10
SLUG_RE = re.compile(r"^[a-z0-9-]{1,80}$")


class Preferences(BaseModel):
    theme: str = "system"
    selectedLocation: str = "harare"
    savedLocations: list[str] = Field(default_factory=list)
    selectedActivities: list[str] = Field(default_factory=list)
    hasOnboarded: bool = False


class CreateDeviceRequest(BaseModel):
    deviceId: Optional[str] = None
    preferences: Preferences = Field(default_factory=Preferences)


class UpdatePreferencesRequest(BaseModel):
    theme: Optional[str] = None
    selectedLocation: Optional[str] = None
    savedLocations: Optional[list[str]] = None
    selectedActivities: Optional[list[str]] = None
    hasOnboarded: Optional[bool] = None


class DeviceProfileResponse(BaseModel):
    deviceId: str
    preferences: Preferences
    createdAt: str
    updatedAt: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _validate_theme(theme: str) -> str:
    if theme not in VALID_THEMES:
        raise HTTPException(status_code=400, detail=f"Invalid theme: {theme}")
    return theme


def _validate_slug(slug: str) -> str:
    if not SLUG_RE.match(slug):
        raise HTTPException(status_code=400, detail=f"Invalid location slug: {slug}")
    return slug


def _validate_activities(activities: list[str]) -> list[str]:
    if len(activities) > MAX_ACTIVITIES:
        raise HTTPException(status_code=400, detail=f"Too many activities (max {MAX_ACTIVITIES})")
    return activities


def _validate_saved_locations(locations: list[str]) -> list[str]:
    """Validate saved locations — format and cap only.

    We intentionally skip a DB existence check here because this runs on
    every preference sync (PATCH, debounced 1.5s). Adding a DB round-trip
    per sync would be expensive. Invalid slugs are handled gracefully on
    the client — SavedLocationsList falls back to title-cased slug display
    when a location isn't found in the DB.
    """
    if len(locations) > MAX_SAVED_LOCATIONS:
        raise HTTPException(status_code=400, detail=f"Too many saved locations (max {MAX_SAVED_LOCATIONS})")
    for slug in locations:
        if not SLUG_RE.match(slug):
            raise HTTPException(status_code=400, detail=f"Invalid location slug: {slug}")
    return locations


def _doc_to_response(doc: dict) -> DeviceProfileResponse:
    prefs = doc.get("preferences", {})
    return DeviceProfileResponse(
        deviceId=doc["deviceId"],
        preferences=Preferences(
            theme=prefs.get("theme", "system"),
            selectedLocation=prefs.get("selectedLocation", "harare"),
            savedLocations=prefs.get("savedLocations", []),
            selectedActivities=prefs.get("selectedActivities", []),
            hasOnboarded=prefs.get("hasOnboarded", False),
        ),
        createdAt=doc.get("createdAt", datetime.now(timezone.utc)).isoformat(),
        updatedAt=doc.get("updatedAt", datetime.now(timezone.utc)).isoformat(),
    )


_indexes_ensured = False


def _ensure_indexes():
    global _indexes_ensured
    if _indexes_ensured:
        return
    device_profiles_collection().create_index("deviceId", unique=True)
    _indexes_ensured = True


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/api/py/devices", status_code=201)
async def create_device(body: CreateDeviceRequest):
    _ensure_indexes()
    device_id = body.deviceId or str(uuid.uuid4())
    _validate_theme(body.preferences.theme)
    _validate_slug(body.preferences.selectedLocation)
    _validate_saved_locations(body.preferences.savedLocations)
    _validate_activities(body.preferences.selectedActivities)

    now = datetime.now(timezone.utc)
    doc = {
        "deviceId": device_id,
        "preferences": body.preferences.model_dump(),
        "createdAt": now,
        "updatedAt": now,
    }

    try:
        device_profiles_collection().insert_one(doc)
    except DuplicateKeyError:
        existing = device_profiles_collection().find_one({"deviceId": device_id})
        if existing:
            return _doc_to_response(existing)
        raise HTTPException(status_code=409, detail="Device profile already exists")

    return _doc_to_response(doc)


@router.get("/api/py/devices/{device_id}")
async def get_device(device_id: str):
    doc = device_profiles_collection().find_one({"deviceId": device_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Device profile not found")
    return _doc_to_response(doc)


@router.patch("/api/py/devices/{device_id}")
async def update_preferences(device_id: str, body: UpdatePreferencesRequest):
    # NOTE: Last-write-wins merge strategy. If a user has multiple devices,
    # whichever syncs last determines the server value for fields like
    # selectedActivities (the entire array is replaced, not merged).
    # A CRDT or per-field timestamp merge is a future enhancement.
    updates: dict = {}
    if body.theme is not None:
        _validate_theme(body.theme)
        updates["preferences.theme"] = body.theme
    if body.selectedLocation is not None:
        _validate_slug(body.selectedLocation)
        updates["preferences.selectedLocation"] = body.selectedLocation
    if body.savedLocations is not None:
        _validate_saved_locations(body.savedLocations)
        updates["preferences.savedLocations"] = body.savedLocations
    if body.selectedActivities is not None:
        _validate_activities(body.selectedActivities)
        updates["preferences.selectedActivities"] = body.selectedActivities
    if body.hasOnboarded is not None:
        updates["preferences.hasOnboarded"] = body.hasOnboarded

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    updates["updatedAt"] = datetime.now(timezone.utc)

    result = device_profiles_collection().find_one_and_update(
        {"deviceId": device_id},
        {"$set": updates},
        return_document=True,
    )

    if not result:
        raise HTTPException(status_code=404, detail="Device profile not found")

    return _doc_to_response(result)
