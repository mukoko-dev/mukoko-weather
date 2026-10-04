-- Hourly limits for station registration (3 an hour) and manual readings
-- (12 an hour) per client, as in the Python backend. `client` is a SHA-256
-- of the client IP, never the IP itself. Rows older than a day are deleted
-- on write.
CREATE TABLE IF NOT EXISTS rate_events (
  client TEXT NOT NULL,
  action TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS rate_events_lookup ON rate_events (client, action, at);
