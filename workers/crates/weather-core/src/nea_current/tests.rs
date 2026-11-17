//! Golden tests on recorded NEA payloads (api-open.data.gov.sg v2, trimmed to a
//! few stations; `tests/fixtures/nea/`). Nothing here touches the network.
//!
//! - `storm-2026-11-17T1750`: the real downpour of 2026-11-17, as the API
//!   answered `?date=2026-11-17T17:50:00`: Woodlands Avenue 9 read 9.0 mm in
//!   five minutes, and NEA forecast "Thundery Showers" over the area.
//! - `night-2026-11-17T2306`: the night the owner saw 24.0 C and fog, as the API
//!   answered at 23:06 SGT: stations 25.5 to 27.8 C, "Cloudy" everywhere.

use super::*;
use crate::wmo;

macro_rules! fixture_set {
    ($dir:literal) => {
        [
            include_str!(concat!(
                "../../tests/fixtures/nea/",
                $dir,
                "/air-temperature.json"
            )),
            include_str!(concat!(
                "../../tests/fixtures/nea/",
                $dir,
                "/relative-humidity.json"
            )),
            include_str!(concat!("../../tests/fixtures/nea/", $dir, "/rainfall.json")),
            include_str!(concat!(
                "../../tests/fixtures/nea/",
                $dir,
                "/wind-speed.json"
            )),
            include_str!(concat!(
                "../../tests/fixtures/nea/",
                $dir,
                "/wind-direction.json"
            )),
            include_str!(concat!(
                "../../tests/fixtures/nea/",
                $dir,
                "/two-hr-forecast.json"
            )),
        ]
    };
}

const STORM: [&str; 6] = fixture_set!("storm-2026-11-17T1750");
const NIGHT: [&str; 6] = fixture_set!("night-2026-11-17T2306");

fn json_of(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

fn snapshot(set: &[&str; 6]) -> Snapshot {
    Snapshot {
        fetched_at_ms: 0,
        temperature: parse_readings(&json_of(set[0])),
        humidity: parse_readings(&json_of(set[1])),
        rainfall: parse_readings(&json_of(set[2])),
        wind_speed: parse_readings(&json_of(set[3])),
        wind_direction: parse_readings(&json_of(set[4])),
        forecast: parse_forecast(&json_of(set[5])),
    }
}

/// Milliseconds for an RFC 3339 time.
fn at(s: &str) -> i64 {
    DateTime::parse_from_rfc3339(s).unwrap().timestamp_millis()
}

/// An Open-Meteo `current` as the forecast Worker serves it.
fn model_current(code: i64) -> Value {
    json!({
        "time": "2026-11-17T23:00",
        "temperature_2m": 24.0,
        "relative_humidity_2m": 100,
        "apparent_temperature": 26.4,
        "precipitation": 0.0,
        "weather_code": code,
        "cloud_cover": 100,
        "wind_speed_10m": 3.0,
        "wind_direction_10m": 90,
        "wind_gusts_10m": 8.0,
        "uv_index": 0.0,
        "surface_pressure": 1008.2,
        "is_day": 0
    })
}

fn payload(code: i64) -> Value {
    json!({
        "current": model_current(code),
        "hourly": {"time": ["2026-11-17T23:00"], "weather_code": [code]},
        "baseline": {"blend": true}
    })
}

const WOODLANDS: (f64, f64) = (1.4439, 103.7854);
const CENTRAL: (f64, f64) = (1.3521, 103.8198);

// ---- the mapping table ----------------------------------------------------

/// Every phrase NEA publishes, copied from the dataset's API spec (v1.0.11,
/// "Possible values for forecast include"), with the code each must give.
const PUBLISHED: [(&str, Sky); 23] = [
    ("Fair", Sky::Code(1)),
    ("Fair (Day)", Sky::Code(1)),
    ("Fair (Night)", Sky::Code(1)),
    ("Fair and Warm", Sky::Code(1)),
    ("Partly Cloudy", Sky::Code(2)),
    ("Partly Cloudy (Day)", Sky::Code(2)),
    ("Partly Cloudy (Night)", Sky::Code(2)),
    ("Cloudy", Sky::Code(3)),
    ("Hazy", Sky::NotStated),
    ("Slightly Hazy", Sky::NotStated),
    ("Windy", Sky::NotStated),
    ("Mist", Sky::Code(45)),
    ("Fog", Sky::Code(45)),
    ("Light Rain", Sky::Code(61)),
    ("Moderate Rain", Sky::Code(63)),
    ("Heavy Rain", Sky::Code(65)),
    ("Passing Showers", Sky::Code(80)),
    ("Light Showers", Sky::Code(80)),
    ("Showers", Sky::Code(81)),
    ("Heavy Showers", Sky::Code(81)),
    ("Thundery Showers", Sky::Code(95)),
    ("Heavy Thundery Showers", Sky::Code(95)),
    ("Heavy Thundery Showers with Gusty Winds", Sky::Code(95)),
];

#[test]
fn every_phrase_nea_publishes_has_its_code() {
    for (phrase, want) in PUBLISHED {
        assert_eq!(sky_for_phrase(phrase), want, "{phrase}");
    }
    // The table holds exactly those phrases, once each.
    assert_eq!(PHRASES.len(), PUBLISHED.len());
    for (i, (phrase, _)) in PHRASES.iter().enumerate() {
        assert_eq!(PUBLISHED[i].0, *phrase, "table row {i}");
    }
}

#[test]
fn every_code_in_the_table_is_one_the_app_can_name() {
    for (phrase, code) in PHRASES {
        if let Some(code) = code {
            assert!(
                wmo::known_description(code).is_some(),
                "{phrase} maps to {code}, which the app has no label for"
            );
        }
    }
}

#[test]
fn every_phrase_in_the_recorded_payloads_is_in_the_table() {
    for set in [&STORM, &NIGHT] {
        let f = parse_forecast(&json_of(set[5])).unwrap();
        assert!(!f.areas.is_empty());
        for a in &f.areas {
            assert_ne!(sky_for_phrase(&a.phrase), Sky::Unknown, "{}", a.phrase);
        }
    }
}

#[test]
fn spelling_and_spacing_do_not_matter() {
    for phrase in [
        "cloudy",
        "  CLOUDY ",
        "Fair & Warm",
        "fair  and   warm",
        "Partly cloudy (day)",
    ] {
        assert_ne!(sky_for_phrase(phrase), Sky::Unknown, "{phrase:?}");
    }
    assert_eq!(sky_for_phrase("Fair & Warm"), Sky::Code(1));
}

#[test]
fn an_unknown_phrase_is_never_guessed_and_never_panics() {
    for phrase in [
        "",
        "   ",
        "Snow",
        "Fair (Evening)",
        "Heavy Thundery Showers with Gusty Winds and Hail",
        "Cloudy; drop table",
        "\u{1f327}",
        &"x".repeat(10_000),
    ] {
        assert_eq!(sky_for_phrase(phrase), Sky::Unknown, "{phrase:.20?}");
    }
    // Unknown: the model's code stands, fog included.
    for model in [None, Some(0), Some(45), Some(65), Some(-1), Some(i64::MAX)] {
        assert_eq!(weather_code(model, Sky::Unknown, None), None);
    }
}

// ---- merging the sky with the gauge ---------------------------------------

#[test]
fn the_models_fog_never_survives_an_nea_answer_that_is_not_fog() {
    for fog in [45, 48] {
        for (phrase, _) in PUBLISHED {
            let sky = sky_for_phrase(phrase);
            let got = weather_code(Some(fog), sky, None);
            match phrase {
                // NEA says fog or mist: fog is what NEA says.
                "Fog" | "Mist" => assert_eq!(got, Some(45), "{phrase}"),
                // A sky of its own, or no sky and no fog: never 45 or 48.
                _ => assert!(
                    got.is_some_and(|c| c != 45 && c != 48),
                    "{phrase} over model {fog}: {got:?}"
                ),
            }
        }
    }
    assert_eq!(weather_code(Some(45), Sky::Code(3), None), Some(3));
    assert_eq!(weather_code(Some(48), Sky::Code(1), None), Some(1));
    // Hazy, windy: no sky of their own, so overcast, as the model's 100 % cloud had it.
    assert_eq!(weather_code(Some(45), Sky::NotStated, None), Some(3));
    // Nothing to say about fog when the model had none.
    assert_eq!(weather_code(Some(2), Sky::NotStated, None), None);
}

#[test]
fn a_gauge_that_shows_rain_lifts_the_sky_to_rain() {
    let sky = Sky::Code(3);
    // 5-minute totals: 0.2 mm is 2.4 mm/h (slight); 0.4 is 4.8 (moderate);
    // 0.8 is 9.6 (heavy); 4.2 is 50.4 (violent).
    assert_eq!(weather_code(Some(0), sky, Some(0.0)), Some(3));
    assert_eq!(weather_code(Some(0), sky, Some(0.2)), Some(61));
    assert_eq!(weather_code(Some(0), sky, Some(0.4)), Some(63));
    assert_eq!(weather_code(Some(0), sky, Some(0.8)), Some(65));
    assert_eq!(weather_code(Some(0), sky, Some(4.2)), Some(65));
    // Under "Showers" it is showers, and never less than NEA's own phrase.
    assert_eq!(weather_code(Some(0), Sky::Code(80), Some(0.2)), Some(80));
    assert_eq!(weather_code(Some(0), Sky::Code(80), Some(0.8)), Some(81));
    assert_eq!(weather_code(Some(0), Sky::Code(81), Some(0.2)), Some(81));
    assert_eq!(weather_code(Some(0), Sky::Code(81), Some(4.2)), Some(82));
    // Under a thundery phrase it is a thunderstorm.
    assert_eq!(weather_code(Some(0), Sky::Code(95), Some(0.2)), Some(95));
    // Under a rain phrase, the stronger of the two.
    assert_eq!(weather_code(Some(0), Sky::Code(61), Some(0.8)), Some(65));
    assert_eq!(weather_code(Some(0), Sky::Code(65), Some(0.2)), Some(65));
    // No phrase to go by: plain rain by intensity, and the model's code never
    // decides how hard it is raining.
    assert_eq!(weather_code(Some(0), Sky::Unknown, Some(0.2)), Some(61));
    assert_eq!(weather_code(Some(82), Sky::NotStated, Some(0.4)), Some(63));
}

#[test]
fn a_dry_gauge_does_not_cancel_nea_forecast_showers() {
    assert_eq!(weather_code(Some(0), Sky::Code(95), Some(0.0)), Some(95));
    assert_eq!(weather_code(Some(0), Sky::Code(81), None), Some(81));
    // A dry gauge and no phrase: the model's code is left alone.
    assert_eq!(weather_code(Some(65), Sky::Unknown, Some(0.0)), None);
}

#[test]
fn rain_intensity_follows_wmo_rates() {
    assert_eq!(rain_intensity(0.0), None);
    assert_eq!(rain_intensity(-1.0), None);
    assert_eq!(rain_intensity(f64::NAN), None);
    assert_eq!(rain_intensity(f64::INFINITY), None);
    assert_eq!(rain_intensity(0.2), Some(Intensity::Slight));
    assert_eq!(rain_intensity(0.2083), Some(Intensity::Slight));
    assert_eq!(rain_intensity(0.21), Some(Intensity::Moderate));
    assert_eq!(rain_intensity(0.63), Some(Intensity::Moderate));
    assert_eq!(rain_intensity(0.64), Some(Intensity::Heavy));
    assert_eq!(rain_intensity(4.1), Some(Intensity::Heavy));
    assert_eq!(rain_intensity(4.2), Some(Intensity::Violent));
}

// ---- the island -----------------------------------------------------------

#[test]
fn the_box_holds_the_island_and_its_islands_and_not_its_neighbours() {
    for (name, lat, lon) in [
        ("Woodlands", 1.4439, 103.7854),
        ("central", 1.3521, 103.8198),
        ("Changi", 1.3644, 103.9915),
        ("Tuas", 1.2937, 103.6184),
        ("Jurong Island", 1.2542, 103.6741),
        ("Sentosa", 1.2494, 103.8303),
        ("Pulau Ubin", 1.4047, 103.9627),
        ("Pulau Tekong", 1.4036, 104.0535),
        ("Semakau", 1.1902, 103.7657),
        ("Marina Bay", 1.2816, 103.8636),
    ] {
        assert!(in_singapore(lat, lon), "{name}");
    }
    for (name, lat, lon) in [
        ("Johor Bahru", 1.4927, 103.7414),
        ("Batam Centre", 1.1301, 104.0529),
        ("Nongsa", 1.1887, 104.0907),
        ("Kuala Lumpur", 3.139, 101.6869),
        ("Harare", -17.8292, 31.0522),
        ("origin", 0.0, 0.0),
        ("NaN", f64::NAN, 103.8),
        ("infinity", 1.35, f64::INFINITY),
    ] {
        assert!(!in_singapore(lat, lon), "{name}");
    }
}

// ---- golden: the downpour -------------------------------------------------

#[test]
fn heavy_rain_at_the_nearest_gauge_beats_a_model_that_says_clear() {
    let snap = snapshot(&STORM);
    // 17:58 SGT: the 17:50 readings are 8 minutes old.
    let now = at("2026-11-17T17:58:00+08:00");
    let mut data = payload(0);
    assert!(apply(&mut data, &snap, WOODLANDS.0, WOODLANDS.1, now));
    let c = &data["current"];
    // Woodlands Avenue 9 is under the point: 9.0 mm in 5 minutes is 108 mm/h.
    assert_eq!(c["precipitation"], 9.0);
    assert_eq!(c["weather_code"], 95, "NEA forecast Thundery Showers");
    assert_eq!(c["temperature_2m"], 24.9);
    assert_eq!(c["relative_humidity_2m"], 99.4);
    // 15.8 knots.
    assert_eq!(c["wind_speed_10m"], 29.26);
    assert_eq!(c["wind_direction_10m"], 224.0);
    // The model's gust (8.0) was lighter than the observed wind.
    assert_eq!(c["wind_gusts_10m"], 29.26);
    assert_eq!(c["time"], "2026-11-17T09:50:00Z");
    // "Feels like" follows the observed temperature, humidity and wind.
    assert_eq!(
        c["apparent_temperature"],
        json!(crate::history::apparent_temperature(Some(24.9), Some(99.4), Some(29.26)).unwrap())
    );
    // What NEA does not measure stays the model's.
    assert_eq!(c["is_day"], 0);
    assert_eq!(c["cloud_cover"], 100);
    assert_eq!(c["surface_pressure"], 1008.2);
    assert_eq!(c["uv_index"], 0.0);
    // Everything outside `current` is untouched.
    assert_eq!(data["hourly"], payload(0)["hourly"]);
    assert_eq!(data["baseline"], payload(0)["baseline"]);
}

#[test]
fn the_downpour_is_a_storm_for_the_hero_and_rain_under_a_cloudy_phrase() {
    let snap = snapshot(&STORM);
    let now = at("2026-11-17T17:58:00+08:00");
    // Kranji Road read 6.8 mm in 5 minutes, and Woodlands' phrase is "Thundery
    // Showers": a storm. Sentosa's phrase is "Showers" and its gauge is dry:
    // showers (81), from NEA's phrase alone.
    let mut data = payload(1);
    assert!(apply(&mut data, &snap, 1.4256, 103.7618, now));
    assert_eq!(data["current"]["weather_code"], 95);
    let mut data = payload(1);
    assert!(apply(&mut data, &snap, 1.2494, 103.8303, now));
    assert_eq!(data["current"]["weather_code"], 81);
    assert_eq!(data["current"]["precipitation"], 0.0);
    // Changi: "Partly Cloudy (Day)" and a dry gauge. NEA says it is dry, so the
    // model's thunderstorm is replaced.
    let mut data = payload(95);
    assert!(apply(&mut data, &snap, 1.3644, 103.9915, now));
    assert_eq!(data["current"]["weather_code"], 2);
    assert_eq!(data["current"]["precipitation"], 0.0);
}

#[test]
fn the_overlay_says_where_it_came_from() {
    let snap = snapshot(&STORM);
    let now = at("2026-11-17T17:58:00+08:00");
    let mut data = payload(0);
    assert!(apply(&mut data, &snap, WOODLANDS.0, WOODLANDS.1, now));
    let o = &data["current_overlay"];
    assert_eq!(o["source"], SOURCE_ID);
    assert_eq!(o["source"], "nea");
    assert_eq!(o["attribution"], ATTRIBUTION);
    assert_eq!(o["licenceUrl"], LICENCE_URL);
    assert!(ATTRIBUTION.contains("Singapore Open Data Licence version 1.0"));
    assert!(ATTRIBUTION.contains("data.gov.sg"));
    assert_eq!(o["observedAt"], "2026-11-17T09:50:00Z");
    assert_eq!(
        o["fields"]["temperature_2m"]["station"],
        "Woodlands Avenue 9"
    );
    assert_eq!(o["fields"]["temperature_2m"]["distanceKm"], 0.0);
    assert_eq!(
        o["fields"]["precipitation"]["station"],
        "Woodlands Avenue 9"
    );
    assert_eq!(o["sky"]["phrase"], "Thundery Showers");
    assert_eq!(o["sky"]["area"], "Woodlands");
    assert_eq!(o["sky"]["validUntil"], "2026-11-17T11:30:00Z");
    assert_eq!(o["weatherCode"], 95);
}

// ---- golden: the foggy night ----------------------------------------------

#[test]
fn nea_cloudy_replaces_the_models_fog_and_the_stations_replace_its_temperature() {
    let snap = snapshot(&NIGHT);
    let now = at("2026-11-17T23:06:30+08:00");
    let mut data = payload(45);
    assert!(apply(&mut data, &snap, CENTRAL.0, CENTRAL.1, now));
    let c = &data["current"];
    // The model said 24.0 C, fog, 100 %. NEA said Cloudy, and Ang Mo Kio
    // Avenue 5, the nearest station (4.5 km), 26.4 C and 94.7 %.
    assert_eq!(c["weather_code"], 3);
    assert_eq!(c["temperature_2m"], 26.4);
    assert_eq!(c["relative_humidity_2m"], 94.7);
    assert_eq!(c["wind_speed_10m"], 2.78);
    assert_eq!(c["wind_direction_10m"], 280.0);
    // The model's gust (8.0) is above the observed wind: it stands.
    assert_eq!(c["wind_gusts_10m"], 8.0);
    // Dry at MacRitchie Reservoir, 1.9 km away.
    assert_eq!(c["precipitation"], 0.0);
    // The newest reading used: the 23:03 humidity.
    assert_eq!(c["time"], "2026-11-17T15:03:00Z");
    let o = &data["current_overlay"];
    assert_eq!(
        o["fields"]["temperature_2m"]["station"],
        "Ang Mo Kio Avenue 5"
    );
    assert_eq!(o["fields"]["temperature_2m"]["distanceKm"], 4.5);
    assert_eq!(
        o["fields"]["precipitation"]["station"],
        "Macritchie Reservoir"
    );
    assert_eq!(o["sky"]["area"], "Bishan");
}

#[test]
fn the_nearest_station_wins_and_a_stale_nearer_one_is_skipped() {
    let near = |station: &str, km_north: f64, value: f64, at_ms: i64| Reading {
        station: station.to_owned(),
        lat: 1.35 + km_north / 111.19,
        lon: 103.82,
        value,
        at_ms,
    };
    let now = at("2026-11-17T12:00:00Z");
    let r = [
        near("stale and nearest", 1.0, 99.0, now - 21 * 60_000),
        near("nearer", 2.0, 27.0, now - 5 * 60_000),
        near("farther", 3.0, 28.0, now),
    ];
    let (hit, d) = nearest_reading(&r, 1.35, 103.82, now, MAX_STATION_KM).unwrap();
    assert_eq!(hit.station, "nearer");
    assert!((d - 2.0).abs() < 0.01);
    // A tie is broken by name, so the answer never depends on NEA's order.
    let tie = [near("b", 2.0, 1.0, now), near("a", 2.0, 2.0, now)];
    assert_eq!(
        nearest_reading(&tie, 1.35, 103.82, now, MAX_STATION_KM)
            .unwrap()
            .0
            .station,
        "a"
    );
}

// ---- stale readings -------------------------------------------------------

#[test]
fn a_reading_is_current_for_twenty_minutes() {
    let now = at("2026-11-17T12:00:00Z");
    let reading = |age_ms: i64| {
        vec![Reading {
            station: "s".into(),
            lat: 1.35,
            lon: 103.82,
            value: 1.0,
            at_ms: now - age_ms,
        }]
    };
    let get = |age_ms: i64| nearest_reading(&reading(age_ms), 1.35, 103.82, now, 8.0).is_some();
    assert!(get(0));
    assert!(get(MAX_READING_AGE_MS));
    assert!(!get(MAX_READING_AGE_MS + 1));
    // From the future: a little clock skew is fine, a lot is junk.
    assert!(get(-60_000));
    assert!(!get(-10 * 60_000));
}

#[test]
fn stale_readings_are_not_used_but_the_current_forecast_still_is() {
    let snap = snapshot(&NIGHT);
    // 23:25 SGT: temperature (22:58) and the gauge (22:55) are 27 and 30 minutes
    // old, humidity (23:03) 22. The forecast is valid until 00:30.
    let now = at("2026-11-17T23:25:00+08:00");
    let mut data = payload(45);
    assert!(apply(&mut data, &snap, CENTRAL.0, CENTRAL.1, now));
    let c = &data["current"];
    assert_eq!(c["weather_code"], 3);
    assert_eq!(
        c["temperature_2m"], 24.0,
        "the model's, not a stale reading"
    );
    assert_eq!(c["relative_humidity_2m"], 100);
    assert_eq!(c["precipitation"], 0.0);
    assert_eq!(c["time"], "2026-11-17T23:00", "no observation, no new time");
    assert_eq!(
        data["current_overlay"]["fields"],
        json!({}),
        "no reading was used, so none is claimed"
    );
    assert!(data["current_overlay"]["observedAt"].is_null());
}

#[test]
fn nothing_current_and_the_forecast_over_leaves_the_forecast_exactly_as_it_was() {
    let snap = snapshot(&NIGHT);
    // 01:00 SGT: the 22:30 to 00:30 forecast is over and every reading is hours old.
    let now = at("2026-11-18T01:00:00+08:00");
    let before = payload(45);
    let mut data = before.clone();
    assert!(!apply(&mut data, &snap, CENTRAL.0, CENTRAL.1, now));
    assert_eq!(data, before);
    // A forecast period that has not started yet is not "now" either.
    let mut data = before.clone();
    assert!(!apply(
        &mut data,
        &snap,
        CENTRAL.0,
        CENTRAL.1,
        at("2026-11-17T21:00:00+08:00")
    ));
    assert_eq!(data, before);
}

// ---- too far --------------------------------------------------------------

#[test]
fn a_station_is_used_within_eight_kilometres_and_a_gauge_within_five() {
    let now = at("2026-11-17T12:00:00Z");
    let reading = |km_north: f64| {
        vec![Reading {
            station: "s".into(),
            lat: 1.30 + km_north / 111.19,
            lon: 103.82,
            value: 1.0,
            at_ms: now,
        }]
    };
    let station_hit =
        |km| nearest_reading(&reading(km), 1.30, 103.82, now, MAX_STATION_KM).is_some();
    let gauge_hit = |km| nearest_reading(&reading(km), 1.30, 103.82, now, MAX_GAUGE_KM).is_some();
    assert!(station_hit(7.9));
    assert!(!station_hit(8.1));
    assert!(gauge_hit(4.9));
    assert!(!gauge_hit(5.1));
}

#[test]
fn a_point_in_the_box_with_nothing_near_it_gets_nothing() {
    let snap = snapshot(&NIGHT);
    let now = at("2026-11-17T23:06:30+08:00");
    // East of Pulau Tekong, in the box and 23 km from the nearest station
    // in the fixture, and farther than that from every forecast area in it.
    let (lat, lon) = (1.1887, 104.0847);
    assert!(in_singapore(lat, lon));
    assert!(overlay(&snap, lat, lon, now, &model_current(45)).is_none());
    let before = payload(45);
    let mut data = before.clone();
    assert!(!apply(&mut data, &snap, lat, lon, now));
    assert_eq!(data, before);
}

// ---- outside Singapore ----------------------------------------------------

#[test]
fn a_point_outside_singapore_is_never_touched() {
    let storm = snapshot(&STORM);
    let now = at("2026-11-17T17:58:00+08:00");
    for (lat, lon) in [
        (1.4927, 103.7414),
        (1.1301, 104.0529),
        (3.139, 101.6869),
        (-17.8292, 31.0522),
        (0.0, 0.0),
        (f64::NAN, f64::NAN),
    ] {
        let before = payload(0);
        let mut data = before.clone();
        assert!(!apply(&mut data, &storm, lat, lon, now), "{lat},{lon}");
        assert_eq!(data, before);
        assert!(overlay(&storm, lat, lon, now, &before["current"]).is_none());
    }
}

// ---- junk -----------------------------------------------------------------

#[test]
fn junk_from_nea_parses_to_nothing() {
    let junk = [
        Value::Null,
        json!(""),
        json!("<html>Too Many Requests</html>"),
        json!(42),
        json!([]),
        json!({}),
        json!({"code": 5, "errorMsg": "rate limited"}),
        json!({"code": 0}),
        json!({"code": 0, "data": null}),
        json!({"code": 0, "data": {}}),
        json!({"code": 0, "data": {"stations": 3, "readings": "x"}}),
        json!({"code": 0, "data": {"stations": [], "readings": []}}),
        json!({"code": 0, "data": {"stations": [{"id": 7}], "readings": [{"timestamp": 1, "data": [null]}]}}),
        json!({"code": 0, "data": {"stations": [{"id": "S1", "location": {}}],
            "readings": [{"timestamp": "yesterday", "data": [{"stationId": "S1", "value": 1}]}]}}),
        json!({"code": 0, "data": {"area_metadata": [], "items": []}}),
        json!({"code": 0, "data": {"area_metadata": 1, "items": [{"forecasts": 2}]}}),
    ];
    for j in &junk {
        assert!(parse_readings(j).is_empty(), "{j}");
        assert!(parse_forecast(j).is_none(), "{j}");
    }
    // A reading with no usable number, location or time is dropped, not guessed.
    let partly = json!({"code": 0, "data": {
    "stations": [
        {"id": "S1", "name": "good", "location": {"latitude": 1.3, "longitude": 103.8}},
        {"id": "S2", "name": "no value", "location": {"latitude": 1.3, "longitude": 103.8}},
        {"id": "S3", "name": "no place", "location": {}},
        {"id": "S4", "name": "NaN", "location": {"latitude": 1.3, "longitude": 103.8}}
    ],
    "readings": [{"timestamp": "2026-11-17T12:00:00+08:00", "data": [
        {"stationId": "S1", "value": 26.4},
        {"stationId": "S2", "value": null},
        {"stationId": "S3", "value": 1},
        {"stationId": "S4", "value": "not a number"},
        {"stationId": "S9", "value": 5}
    ]}]}});
    let got = parse_readings(&partly);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].station, "good");
    assert_eq!(got[0].value, 26.4);
}

#[test]
fn an_empty_or_junk_snapshot_changes_nothing() {
    let before = payload(0);
    for snap in [
        Snapshot::default(),
        Snapshot {
            fetched_at_ms: 1,
            temperature: parse_readings(&json!("junk")),
            forecast: parse_forecast(&json!({"code": 0, "data": {}})),
            ..Snapshot::default()
        },
    ] {
        assert!(snap.is_empty());
        let mut data = before.clone();
        assert!(!apply(
            &mut data,
            &snap,
            WOODLANDS.0,
            WOODLANDS.1,
            at("2026-11-17T17:58:00+08:00")
        ));
        assert_eq!(data, before);
    }
    // A payload that is not an object is never written to.
    for mut odd in [Value::Null, json!([1, 2]), json!("x")] {
        let before = odd.clone();
        assert!(!apply(
            &mut odd,
            &snapshot(&STORM),
            WOODLANDS.0,
            WOODLANDS.1,
            at("2026-11-17T17:58:00+08:00")
        ));
        assert_eq!(odd, before);
    }
}

#[test]
fn a_payload_with_no_current_gets_one() {
    let mut data = json!({"hourly": {}});
    assert!(apply(
        &mut data,
        &snapshot(&STORM),
        WOODLANDS.0,
        WOODLANDS.1,
        at("2026-11-17T17:58:00+08:00")
    ));
    assert_eq!(data["current"]["precipitation"], 9.0);
    assert_eq!(data["current"]["weather_code"], 95);
}

#[test]
fn implausible_readings_fail_the_station_qc() {
    let now = at("2026-11-17T12:00:00Z");
    let r = |v: f64| Reading {
        station: "s".into(),
        lat: 1.35,
        lon: 103.82,
        value: v,
        at_ms: now,
    };
    let snap = Snapshot {
        temperature: vec![r(99.0)],
        humidity: vec![r(140.0)],
        rainfall: vec![r(900.0)],
        ..Snapshot::default()
    };
    assert!(overlay(&snap, 1.35, 103.82, now, &model_current(0)).is_none());
}

// ---- parsing and the cache ------------------------------------------------

#[test]
fn the_newest_reading_per_station_wins() {
    let payload = json!({"code": 0, "data": {
    "stations": [{"id": "S1", "name": "one", "location": {"latitude": 1.3, "longitude": 103.8}}],
    "readings": [
        {"timestamp": "2026-11-17T12:00:00+08:00", "data": [{"stationId": "S1", "value": 1.0}]},
        {"timestamp": "2026-11-17T12:10:00+08:00", "data": [{"stationId": "S1", "value": 3.0}]},
        {"timestamp": "2026-11-17T12:05:00+08:00", "data": [{"stationId": "S1", "value": 2.0}]}
    ]}});
    let got = parse_readings(&payload);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].value, 3.0);
    assert_eq!(got[0].at_ms, at("2026-11-17T12:10:00+08:00"));
}

#[test]
fn the_recorded_payloads_parse_to_their_stations_and_areas() {
    let night = snapshot(&NIGHT);
    assert_eq!(night.temperature.len(), 8);
    assert_eq!(night.humidity.len(), 8);
    assert_eq!(night.rainfall.len(), 15);
    assert_eq!(night.wind_speed.len(), 6);
    assert_eq!(night.wind_direction.len(), 6);
    let f = night.forecast.as_ref().unwrap();
    assert_eq!(f.areas.len(), 12);
    assert_eq!(f.valid_from_ms, at("2026-11-17T22:30:00+08:00"));
    assert_eq!(f.valid_to_ms, at("2026-11-18T00:30:00+08:00"));
}

#[test]
fn the_snapshot_round_trips_through_the_cache() {
    let snap = Snapshot {
        fetched_at_ms: 1_234,
        ..snapshot(&STORM)
    };
    let text = serde_json::to_string(&snap).unwrap();
    assert_eq!(serde_json::from_str::<Snapshot>(&text).unwrap(), snap);
    // An older or newer row with other fields still reads: never a crash.
    assert_eq!(
        serde_json::from_str::<Snapshot>(r#"{"fetched_at_ms": 5, "future": [1]}"#)
            .unwrap()
            .fetched_at_ms,
        5
    );
    assert!(serde_json::from_str::<Snapshot>("not json").is_err());
}

#[test]
fn a_dataset_that_failed_is_carried_over_from_the_last_snapshot() {
    let old = snapshot(&NIGHT);
    let mut fresh = Snapshot {
        fetched_at_ms: 9,
        rainfall: parse_readings(&json_of(STORM[2])),
        ..Snapshot::default()
    };
    fresh.fill_missing_from(&old);
    assert_eq!(fresh.fetched_at_ms, 9);
    assert_eq!(fresh.temperature, old.temperature);
    assert_eq!(fresh.forecast, old.forecast);
    // What the refresh did bring is kept, not overwritten.
    assert_ne!(fresh.rainfall, old.rainfall);
    assert_eq!(fresh.rainfall, parse_readings(&json_of(STORM[2])));
}

#[test]
fn a_snapshot_is_reused_for_two_minutes() {
    let snap = Snapshot {
        fetched_at_ms: 1_000_000,
        ..Snapshot::default()
    };
    assert!(snap.is_fresh(1_000_000));
    assert!(snap.is_fresh(1_000_000 + SNAPSHOT_FRESH_MS - 1));
    assert!(!snap.is_fresh(1_000_000 + SNAPSHOT_FRESH_MS));
    // A clock that moved back: a little is fine, a lot means ask again.
    assert!(snap.is_fresh(1_000_000 - 60_000));
    assert!(!snap.is_fresh(1_000_000 - 3_600_000));
}
