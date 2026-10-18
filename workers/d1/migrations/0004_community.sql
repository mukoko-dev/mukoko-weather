-- Community weather reports and device preference profiles (the Python
-- backend kept both in MongoDB: weather_reports, device_profiles).
-- Reports expire after 24 to 72 hours; rows past expires_at are never read
-- and are deleted on write. Times are epoch milliseconds, like rate_events.
CREATE TABLE IF NOT EXISTS weather_reports (
  id TEXT PRIMARY KEY,
  location_slug TEXT NOT NULL,
  location_name TEXT NOT NULL,
  lat REAL,
  lon REAL,
  report_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  weather_snapshot TEXT,
  reported_by TEXT NOT NULL,
  reported_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS weather_reports_place
  ON weather_reports (location_slug, reported_at DESC);
CREATE INDEX IF NOT EXISTS weather_reports_expiry ON weather_reports (expires_at);

-- One vote per client per report: the primary key is the dedup, and a
-- report's upvotes are the count of its rows here.
CREATE TABLE IF NOT EXISTS report_upvotes (
  report_id TEXT NOT NULL,
  voter TEXT NOT NULL,
  PRIMARY KEY (report_id, voter)
);

-- One profile per device id; preferences is the JSON of the Preferences
-- object (last write wins).
CREATE TABLE IF NOT EXISTS device_profiles (
  device_id TEXT PRIMARY KEY,
  preferences TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
