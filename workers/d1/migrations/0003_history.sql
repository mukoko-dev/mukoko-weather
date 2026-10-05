-- Daily history (mukoko-dev/mukoko-weather#148), written by
-- mukoko-weather-jobs and read by the history endpoint. Times are epoch ms;
-- dates are YYYY-MM-DD.

-- One row per place per day, from the forecast at 23:30 Harare time. This
-- replaces Mongo `weather.weather_history` (one record per fresh fetch).
CREATE TABLE IF NOT EXISTS place_daily (
  slug TEXT NOT NULL,
  date TEXT NOT NULL,                -- the place's local day (first daily entry)
  recorded_at INTEGER NOT NULL,
  source TEXT NOT NULL,              -- tomorrow | open-meteo (never fallback)
  current TEXT,                      -- JSON: WeatherData.current
  daily TEXT,                        -- JSON: date, weatherCode, tempMax, tempMin,
                                     -- apparentTempMax, apparentTempMin, precipSum,
                                     -- precipProbMax, windSpeedMax, windGustMax,
                                     -- windDirDominant, uvIndexMax, sunrise, sunset
  insights TEXT,                     -- JSON: WeatherData.insights
  PRIMARY KEY (slug, date)
);

-- One row per station per UTC day, rolled up from validated observations.
-- Kept after the raw observations are archived to R2.
CREATE TABLE IF NOT EXISTS station_daily (
  station_id TEXT NOT NULL,
  date TEXT NOT NULL,
  observations INTEGER NOT NULL,
  temp_min REAL,                     -- °C
  temp_max REAL,
  temp_mean REAL,
  humidity_mean REAL,                -- %
  precip_sum REAL,                   -- mm: the day's largest reported rainfall value
  wind_max REAL,                     -- km/h
  gust_max REAL,                     -- km/h
  pressure_mean REAL,                -- hPa
  PRIMARY KEY (station_id, date)
);

CREATE INDEX IF NOT EXISTS station_daily_by_date ON station_daily (date);
