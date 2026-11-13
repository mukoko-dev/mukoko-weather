//! The latest validated observation per active station, kept in one KV key
//! (`stations:latest`) for the forecast Worker's blend (mukoko-dev/mukoko-weather#556,
//! #293 Part 5.4 item 4).
//!
//! The stations Worker's queue consumer writes it after each batch (in
//! `nyuchi` mode, where the validated observations live at the Nyuchi API and
//! the forecast Worker can no longer read them from D1); the forecast Worker
//! reads it once per request and picks the observation to overlay with the
//! rule the D1 reader has always used: within 50 km of the point and no older
//! than 60 minutes, the freshest wins.
//!
//! It is derived and disposable. The durable record is `weather.observations`
//! at the API; this key can be deleted at any time and refills as stations
//! upload (every 16 to 60 seconds). It is written by a read-modify-write that
//! two consumers could race on; the loser's station is back with its next
//! upload, so a lost update costs at most one upload interval. A reading the
//! API stores without passing the queue (a manual reading entered at the
//! console) is not in it: that needs a refresh from the API, which has no
//! route for it yet (nyuchi/nyuchi-api#543).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};

use crate::geo::{haversine_km, valid_coordinates};
use crate::station::{valid_station_id, IngestMessage};

/// The KV key.
pub const KV_KEY: &str = "stations:latest";
/// The shape of the value. A reader ignores any other version.
pub const VERSION: u8 = 1;
/// Within 50 km and 60 minutes, as the Python backend and the D1 reader.
pub const MAX_DISTANCE_KM: f64 = 50.0;
pub const MAX_AGE_MS: u64 = 60 * 60_000;
/// The key expires this long after its last write, so a stopped pipeline
/// leaves nothing behind. (KV's minimum is 60.)
pub const KV_TTL_SECONDS: u64 = 2 * 60 * 60;
/// Bounds the value: tens of kilobytes at this size.
pub const MAX_ENTRIES: usize = 5_000;
/// The KV edge cache the reader allows (KV's minimum is 60). Every entry is
/// checked against its own age, so a minute of staleness changes nothing.
pub const READ_CACHE_TTL_SECONDS: u64 = 60;

/// One station's latest validated observation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub lat: f64,
    pub lon: f64,
    /// Epoch ms: when the Worker received the upload.
    pub observed_at: i64,
    /// By stored name, in the platform's units.
    pub metrics: BTreeMap<String, f64>,
}

/// The value of `stations:latest`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: u8,
    /// Epoch ms of the write.
    pub updated_at: i64,
    #[serde(default)]
    pub stations: BTreeMap<String, Entry>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Snapshot {
            version: VERSION,
            updated_at: 0,
            stations: BTreeMap::new(),
        }
    }
}

/// The observation the forecast overlays.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub station_id: String,
    /// Epoch ms.
    pub observed_at: i64,
    pub distance_km: f64,
    /// The metrics as the `station_current` mapping reads them.
    pub metrics: Map<String, Value>,
}

/// The entry an upload makes, or `None` when nothing in it passed quality
/// control (it is not an observation).
pub fn entry_of(m: &IngestMessage) -> Option<(String, Entry)> {
    (!m.validated.is_empty()).then(|| {
        (
            m.station_id.clone(),
            Entry {
                lat: m.lat,
                lon: m.lon,
                observed_at: m.received_at,
                metrics: m.validated.clone(),
            },
        )
    })
}

fn age_ms(observed_at: i64, now_ms: u64) -> u64 {
    // An observation stamped ahead of this clock is as fresh as it gets.
    (now_ms as i64).saturating_sub(observed_at).max(0) as u64
}

impl Snapshot {
    /// Whether this reader understands the value.
    pub fn is_current(&self) -> bool {
        self.version == VERSION
    }

    /// Fold new observations in, then drop what is too old to use and keep the
    /// newest [`MAX_ENTRIES`]. A station keeps its newest observation: an
    /// older one (a redelivered message) never replaces it. An entry that is
    /// already too old, or that has an invalid id or place, is not admitted.
    pub fn merge(&mut self, updates: impl IntoIterator<Item = (String, Entry)>, now_ms: u64) {
        for (id, entry) in updates {
            if !valid_station_id(&id)
                || !valid_coordinates(entry.lat, entry.lon)
                || age_ms(entry.observed_at, now_ms) > MAX_AGE_MS
            {
                continue;
            }
            match self.stations.get(&id) {
                Some(have) if have.observed_at >= entry.observed_at => {}
                _ => {
                    self.stations.insert(id, entry);
                }
            }
        }
        self.stations
            .retain(|_, e| age_ms(e.observed_at, now_ms) <= MAX_AGE_MS);
        if self.stations.len() > MAX_ENTRIES {
            let mut by_age: Vec<(i64, String)> = self
                .stations
                .iter()
                .map(|(id, e)| (e.observed_at, id.clone()))
                .collect();
            by_age.sort_unstable_by(|a, b| b.cmp(a));
            for (_, id) in by_age.into_iter().skip(MAX_ENTRIES) {
                self.stations.remove(&id);
            }
        }
        self.version = VERSION;
        self.updated_at = now_ms as i64;
    }

    /// The observation to overlay at a point: of the stations within 50 km
    /// whose observation is no older than 60 minutes, the freshest (the D1
    /// reader's rule, so the cutover changes no behaviour); the nearer wins a
    /// tie, then the lower id, so the answer never depends on map order.
    pub fn pick(&self, lat: f64, lon: f64, now_ms: u64) -> Option<Hit> {
        if !valid_coordinates(lat, lon) || !self.is_current() {
            return None;
        }
        let mut best: Option<(&String, &Entry, f64)> = None;
        for (id, e) in &self.stations {
            if age_ms(e.observed_at, now_ms) > MAX_AGE_MS {
                continue;
            }
            let d = haversine_km(lat, lon, e.lat, e.lon);
            if d > MAX_DISTANCE_KM {
                continue;
            }
            let better = match best {
                None => true,
                Some((_, b, bd)) => {
                    e.observed_at > b.observed_at || (e.observed_at == b.observed_at && d < bd)
                }
            };
            if better {
                best = Some((id, e, d));
            }
        }
        let (id, e, d) = best?;
        Some(Hit {
            station_id: id.clone(),
            observed_at: e.observed_at,
            distance_km: d,
            metrics: e
                .metrics
                .iter()
                .filter_map(|(k, v)| Number::from_f64(*v).map(|n| (k.clone(), Value::Number(n))))
                .collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_794_560_400_000; // 2026-11-13T09:00:00Z
    const MIN: i64 = 60_000;

    fn entry(lat: f64, lon: f64, age_min: i64, temp: f64) -> Entry {
        Entry {
            lat,
            lon,
            observed_at: NOW as i64 - age_min * MIN,
            metrics: BTreeMap::from([("airTemperatureCelsius".to_owned(), temp)]),
        }
    }

    fn msg(id: &str, at: i64, validated: &[(&str, f64)]) -> IngestMessage {
        IngestMessage {
            station_id: id.into(),
            lat: -17.83,
            lon: 31.05,
            country_code: "ZW".into(),
            received_at: at,
            source: "ecowitt".into(),
            validated: validated
                .iter()
                .map(|(k, v)| ((*k).to_owned(), *v))
                .collect(),
            raw: Map::new(),
        }
    }

    // Harare, and points straight north of it by degrees of latitude
    // (1 degree is 111.195 km on the 6371 km sphere haversine_km uses).
    const HARARE: (f64, f64) = (-17.8292, 31.0522);

    fn north_of_harare(deg: f64) -> (f64, f64) {
        (HARARE.0 + deg, HARARE.1)
    }

    #[test]
    fn an_upload_with_nothing_validated_makes_no_entry() {
        assert!(entry_of(&msg("mws-0a1b2c3d", NOW as i64, &[])).is_none());
        let (id, e) = entry_of(&msg("mws-0a1b2c3d", NOW as i64, &[("uvIndex", 3.0)])).unwrap();
        assert_eq!(id, "mws-0a1b2c3d");
        assert_eq!(e.observed_at, NOW as i64);
        assert_eq!(e.metrics["uvIndex"], 3.0);
        assert_eq!((e.lat, e.lon), (-17.83, 31.05));
    }

    #[test]
    fn a_station_keeps_its_newest_observation() {
        let mut s = Snapshot::default();
        s.merge([("mws-0a1b2c3d".into(), entry(-17.8, 31.0, 5, 20.0))], NOW);
        // A newer one replaces it.
        s.merge([("mws-0a1b2c3d".into(), entry(-17.8, 31.0, 1, 22.0))], NOW);
        assert_eq!(
            s.stations["mws-0a1b2c3d"].metrics["airTemperatureCelsius"],
            22.0
        );
        // A redelivered older one does not.
        s.merge([("mws-0a1b2c3d".into(), entry(-17.8, 31.0, 30, 10.0))], NOW);
        assert_eq!(
            s.stations["mws-0a1b2c3d"].metrics["airTemperatureCelsius"],
            22.0
        );
        assert_eq!(s.stations.len(), 1);
        assert_eq!(s.updated_at, NOW as i64);
    }

    #[test]
    fn many_stations_in_one_batch_are_all_kept() {
        let mut s = Snapshot::default();
        s.merge(
            [
                ("mws-00000001".into(), entry(-17.8, 31.0, 1, 20.0)),
                ("mws-00000002".into(), entry(-18.0, 31.1, 2, 21.0)),
                ("mws-00000003".into(), entry(-19.0, 30.0, 3, 22.0)),
            ],
            NOW,
        );
        assert_eq!(s.stations.len(), 3);
    }

    #[test]
    fn what_is_too_old_to_use_is_dropped_on_every_write() {
        let mut s = Snapshot::default();
        s.merge([("mws-00000001".into(), entry(-17.8, 31.0, 59, 20.0))], NOW);
        assert_eq!(s.stations.len(), 1);
        // Ten minutes later it is 69 minutes old: gone.
        s.merge(
            [("mws-00000002".into(), entry(-17.8, 31.0, 0, 21.0))],
            NOW + 10 * MIN as u64,
        );
        assert!(!s.stations.contains_key("mws-00000001"));
        assert!(s.stations.contains_key("mws-00000002"));
    }

    #[test]
    fn a_stale_or_malformed_update_is_not_admitted() {
        let mut s = Snapshot::default();
        s.merge(
            [
                ("mws-00000001".into(), entry(-17.8, 31.0, 61, 20.0)), // too old
                ("not-a-station".into(), entry(-17.8, 31.0, 1, 20.0)), // bad id
                ("mws-00000002".into(), entry(95.0, 31.0, 1, 20.0)),   // off the globe
                ("mws-00000003".into(), entry(-17.8, 31.0, 1, 20.0)),
            ],
            NOW,
        );
        assert_eq!(s.stations.keys().collect::<Vec<_>>(), ["mws-00000003"]);
    }

    #[test]
    fn the_value_is_bounded_and_keeps_the_newest() {
        let mut s = Snapshot::default();
        let updates = (0..MAX_ENTRIES + 10).map(|i| {
            // Ages 0..=59 minutes, repeating; the cut keeps the freshest.
            (
                format!("mws-{i:08x}"),
                entry(-17.8, 31.0, (i % 60) as i64, 20.0),
            )
        });
        s.merge(updates, NOW);
        assert_eq!(s.stations.len(), MAX_ENTRIES);
        let oldest_kept = s.stations.values().map(|e| e.observed_at).min().unwrap();
        let dropped_is_older = (0..MAX_ENTRIES + 10).all(|i| {
            let id = format!("mws-{i:08x}");
            s.stations.contains_key(&id) || NOW as i64 - ((i % 60) as i64) * MIN <= oldest_kept
        });
        assert!(dropped_is_older, "only the oldest are cut");
    }

    #[test]
    fn the_wire_form_is_camel_case_and_round_trips() {
        let mut s = Snapshot::default();
        s.merge([("mws-0a1b2c3d".into(), entry(-17.36, 30.2, 2, 21.5))], NOW);
        let text = serde_json::to_string(&s).unwrap();
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["version"], 1);
        assert_eq!(v["updatedAt"], NOW);
        assert_eq!(
            v["stations"]["mws-0a1b2c3d"]["observedAt"],
            NOW as i64 - 2 * MIN
        );
        assert_eq!(
            v["stations"]["mws-0a1b2c3d"]["metrics"]["airTemperatureCelsius"],
            21.5
        );
        let back: Snapshot = serde_json::from_str(&text).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn a_reader_tolerates_extra_fields_and_ignores_another_version() {
        let text = r#"{"version": 1, "updatedAt": 5, "future": true, "stations": {
            "mws-0a1b2c3d": {"lat": -17.8, "lon": 31.0, "observedAt": 1794560340000,
                              "metrics": {"uvIndex": 3}, "extra": 1}}}"#;
        let s: Snapshot = serde_json::from_str(text).unwrap();
        assert!(s.is_current());
        assert!(s.pick(-17.8, 31.0, NOW).is_some());
        let v2: Snapshot =
            serde_json::from_str(r#"{"version": 2, "updatedAt": 0, "stations": {}}"#).unwrap();
        assert!(!v2.is_current());
        let mut v2 = v2;
        v2.stations
            .insert("mws-0a1b2c3d".into(), entry(-17.8, 31.0, 1, 20.0));
        assert!(
            v2.pick(-17.8, 31.0, NOW).is_none(),
            "an unknown shape is never read"
        );
        // Not a snapshot at all.
        assert!(serde_json::from_str::<Snapshot>("[]").is_err());
        assert!(serde_json::from_str::<Snapshot>(r#"{"stations": {}}"#).is_err());
    }

    // --- the reader's rule: <= 50 km and <= 60 minutes ------------------------

    fn one(lat: f64, lon: f64, age_min: i64) -> Snapshot {
        let mut s = Snapshot::default();
        s.merge(
            [("mws-0a1b2c3d".into(), entry(lat, lon, age_min, 21.5))],
            NOW,
        );
        s
    }

    #[test]
    fn a_station_just_inside_50_km_is_used_and_one_just_outside_is_not() {
        let (lat_in, lon) = north_of_harare(0.4496); // 49.99 km
        let (lat_out, _) = north_of_harare(0.4497); // 50.00x km
        assert!(haversine_km(HARARE.0, HARARE.1, lat_in, lon) <= 50.0);
        assert!(haversine_km(HARARE.0, HARARE.1, lat_out, lon) > 50.0);
        assert!(one(lat_in, lon, 1).pick(HARARE.0, HARARE.1, NOW).is_some());
        assert!(one(lat_out, lon, 1).pick(HARARE.0, HARARE.1, NOW).is_none());
    }

    #[test]
    fn an_observation_of_exactly_60_minutes_is_used_and_61_is_not() {
        assert!(one(-17.8, 31.0, 59).pick(-17.8, 31.0, NOW).is_some());
        assert!(one(-17.8, 31.0, 60).pick(-17.8, 31.0, NOW).is_some());
        // 60 minutes and a millisecond is past it.
        let s = one(-17.8, 31.0, 60);
        assert!(s.pick(-17.8, 31.0, NOW + 1).is_none());
        // `merge` would not even admit a 61-minute-old observation.
        assert!(one(-17.8, 31.0, 61).stations.is_empty());
    }

    #[test]
    fn nothing_in_range_leaves_the_forecast_unchanged() {
        assert!(Snapshot::default().pick(-17.8, 31.0, NOW).is_none());
        // Bulawayo is about 440 km from Harare.
        assert!(one(-20.15, 28.58, 1)
            .pick(HARARE.0, HARARE.1, NOW)
            .is_none());
    }

    #[test]
    fn of_two_in_range_the_freshest_wins_as_in_the_d1_reader() {
        let mut s = Snapshot::default();
        let (near_lat, near_lon) = north_of_harare(0.01); // about 1 km, older
        let (far_lat, far_lon) = north_of_harare(0.3); // about 33 km, fresher
        s.merge(
            [
                ("mws-00000001".into(), entry(near_lat, near_lon, 20, 19.0)),
                ("mws-00000002".into(), entry(far_lat, far_lon, 3, 23.0)),
            ],
            NOW,
        );
        let hit = s.pick(HARARE.0, HARARE.1, NOW).unwrap();
        assert_eq!(hit.station_id, "mws-00000002");
        assert_eq!(hit.observed_at, NOW as i64 - 3 * MIN);
        assert_eq!(hit.metrics["airTemperatureCelsius"], 23.0);
        assert!(
            hit.distance_km > 30.0 && hit.distance_km < 36.0,
            "{}",
            hit.distance_km
        );
    }

    #[test]
    fn at_the_same_instant_the_nearer_wins_then_the_lower_id() {
        let mut s = Snapshot::default();
        let (a_lat, a_lon) = north_of_harare(0.2);
        let (b_lat, b_lon) = north_of_harare(0.1);
        s.merge(
            [
                ("mws-00000001".into(), entry(a_lat, a_lon, 5, 20.0)),
                ("mws-00000002".into(), entry(b_lat, b_lon, 5, 21.0)),
            ],
            NOW,
        );
        assert_eq!(
            s.pick(HARARE.0, HARARE.1, NOW).unwrap().station_id,
            "mws-00000002"
        );
        // Equal in age and distance: the lower id, whatever the map order.
        let mut t = Snapshot::default();
        t.merge(
            [
                ("mws-00000009".into(), entry(b_lat, b_lon, 5, 21.0)),
                ("mws-00000003".into(), entry(b_lat, b_lon, 5, 22.0)),
            ],
            NOW,
        );
        assert_eq!(
            t.pick(HARARE.0, HARARE.1, NOW).unwrap().station_id,
            "mws-00000003"
        );
    }

    #[test]
    fn a_point_off_the_globe_gets_nothing() {
        let s = one(-17.8, 31.0, 1);
        assert!(s.pick(95.0, 31.0, NOW).is_none());
        assert!(s.pick(f64::NAN, 31.0, NOW).is_none());
    }

    #[test]
    fn an_observation_stamped_ahead_of_the_clock_counts_as_fresh() {
        let mut s = Snapshot::default();
        let mut e = entry(-17.8, 31.0, 0, 20.0);
        e.observed_at = NOW as i64 + 2 * MIN; // a clock a little behind
        s.merge([("mws-0a1b2c3d".into(), e)], NOW);
        assert!(s.pick(-17.8, 31.0, NOW).is_some());
    }

    #[test]
    fn the_hit_feeds_the_existing_current_block_mapping() {
        let s = one(-17.8, 31.0, 1);
        let hit = s.pick(-17.8, 31.0, NOW).unwrap();
        let current = crate::station::station_current(&hit.metrics, "2026-11-13T08:59:00Z");
        assert_eq!(current["temperature_2m"], 21.5);
        assert_eq!(current["relative_humidity_2m"], Value::Null);
        assert_eq!(current["time"], "2026-11-13T08:59:00Z");
    }
}
