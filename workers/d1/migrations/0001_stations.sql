-- The weather backend's own store (mukoko-dev/mukoko-weather#148): stations
-- and their observations. Written by mukoko-weather-stations, read by
-- mukoko-weather-forecast for the StationKit overlay. Times are epoch ms.

CREATE TABLE IF NOT EXISTS stations (
  station_id TEXT PRIMARY KEY,                 -- mws-<8 hex>
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  elevation REAL,
  station_type TEXT NOT NULL DEFAULT 'digital', -- digital | manual
  hardware TEXT,
  country_code TEXT NOT NULL DEFAULT 'ZW',
  status TEXT NOT NULL DEFAULT 'active',
  ingest_key_hash TEXT NOT NULL,               -- PBKDF2-SHA256, 60k, hex
  ingest_key_salt TEXT NOT NULL,
  owner_person_id TEXT,                        -- canonical person id (Nyuchi API)
  last_observation_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES stations (station_id),
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  observed_at INTEGER NOT NULL,
  qc_status TEXT NOT NULL,                     -- validated | rejected
  source_type TEXT NOT NULL,                   -- wunderground | ecowitt | manual
  metrics TEXT NOT NULL,                       -- JSON, platform units
  country_code TEXT NOT NULL DEFAULT 'ZW'
);

CREATE INDEX IF NOT EXISTS observations_recent
  ON observations (qc_status, observed_at, lat, lon);
CREATE INDEX IF NOT EXISTS observations_by_station
  ON observations (station_id, observed_at);
