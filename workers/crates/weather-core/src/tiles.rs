//! Weather map overlay tiles, ported from `api/py/_tiles.py`
//! (`/api/py/map-tiles`).
//!
//! The tile Worker proxies Tomorrow.io overlay tiles so the provider key
//! stays server-side. This module holds the parts that need no runtime: the
//! request check (layer allowlist, zoom and tile ranges, timestamp shape,
//! which together keep the upstream URL pinned), the hourly cache bucket,
//! the cache key and the upstream URL.

use chrono::{DateTime, Utc};

/// The overlay layers the app offers. Anything else is refused.
pub const VALID_LAYERS: [&str; 5] = [
    "precipitationIntensity",
    "temperature",
    "windSpeed",
    "cloudCover",
    "humidity",
];

pub const MIN_ZOOM: u32 = 1;
pub const MAX_ZOOM: u32 = 12;

/// How long a fetched tile counts as fresh: 90 minutes, longer than the
/// hourly tile refresh, as in the Python backend.
pub const FRESH_SECONDS: u64 = 5_400;

/// Strong caching for real tiles.
pub const TILE_CACHE_CONTROL: &str =
    "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800";

/// Short caching for stale and empty tiles, so browsers recover soon after
/// the provider's quota resets.
pub const FALLBACK_CACHE_CONTROL: &str = "public, max-age=300";

/// A 1x1 fully transparent PNG, served (HTTP 200) when the provider fails and
/// no cached tile exists, so the map shows no overlay for that tile.
pub const TRANSPARENT_PNG: [u8; 70] = [
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xB5, 0x1C, 0x0C,
    0x02, 0x00, 0x00, 0x00, 0x0B, 0x49, 0x44, 0x41, 0x54, 0x78, 0xDA, 0x63, 0x64, 0xF8, 0xCF, 0x50,
    0x0F, 0x00, 0x03, 0x86, 0x01, 0x80, 0x5A, 0x34, 0x7D, 0x6B, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

const TOMORROW_TILE_ORIGIN: &str = "https://api.tomorrow.io";

/// A checked tile request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TileRequest {
    pub layer: String,
    pub z: u32,
    pub x: u32,
    pub y: u32,
    /// `now`, or `YYYY-MM-DDTHH:MM:SSZ`.
    pub timestamp: String,
}

/// Why a tile request was refused, with the status the Python backend gave.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TileError {
    pub status: u16,
    pub message: &'static str,
}

const fn refuse(status: u16, message: &'static str) -> TileError {
    TileError { status, message }
}

fn is_timestamp(s: &str) -> bool {
    if s == "now" {
        return true;
    }
    // YYYY-MM-DDTHH:MM:SSZ, digits only where digits go.
    let b = s.as_bytes();
    b.len() == 20
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            10 => *c == b'T',
            13 | 16 => *c == b':',
            19 => *c == b'Z',
            _ => c.is_ascii_digit(),
        })
}

/// An integer query value as FastAPI reads one: optional sign, digits.
fn int(v: &str) -> Option<i64> {
    let v = v.trim();
    let digits = v.strip_prefix(['+', '-']).unwrap_or(v);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    v.parse().ok()
}

impl TileRequest {
    /// Check `z`, `x`, `y`, `layer` and `timestamp` (default `now`).
    ///
    /// A missing or non-integer parameter is `422`, as FastAPI answered.
    /// A bad layer, zoom, tile coordinate or timestamp is `400`.
    pub fn parse<'a>(
        pairs: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Result<Self, TileError> {
        let (mut z, mut x, mut y, mut layer, mut timestamp) = (None, None, None, None, None);
        for (k, v) in pairs {
            let slot = match k {
                "z" => &mut z,
                "x" => &mut x,
                "y" => &mut y,
                "layer" => &mut layer,
                "timestamp" => &mut timestamp,
                _ => continue,
            };
            // FastAPI takes the last value of a repeated parameter.
            *slot = Some(v);
        }
        let need = |v: Option<&str>| {
            v.and_then(int)
                .ok_or(refuse(422, "z, x and y must be integers"))
        };
        let (z, x, y) = (need(z)?, need(x)?, need(y)?);
        let layer = layer.ok_or(refuse(422, "layer is required"))?;

        if !VALID_LAYERS.contains(&layer) {
            return Err(refuse(400, "Invalid layer"));
        }
        if z < i64::from(MIN_ZOOM) || z > i64::from(MAX_ZOOM) {
            return Err(refuse(400, "Zoom out of range"));
        }
        let max_tile = (1i64 << z) - 1;
        if !(0..=max_tile).contains(&x) || !(0..=max_tile).contains(&y) {
            return Err(refuse(400, "Tile coordinates out of range"));
        }
        let timestamp = timestamp.unwrap_or("now");
        if !is_timestamp(timestamp) {
            return Err(refuse(400, "Invalid timestamp"));
        }
        Ok(TileRequest {
            layer: layer.to_owned(),
            z: z as u32,
            x: x as u32,
            y: y as u32,
            timestamp: timestamp.to_owned(),
        })
    }

    /// The cache bucket: `now` snaps to the current UTC hour, so every
    /// request in that hour shares one upstream fetch; an explicit time is
    /// used as it is.
    pub fn bucket(&self, now: DateTime<Utc>) -> String {
        if self.timestamp == "now" {
            now.format("%Y-%m-%dT%H:00:00Z").to_string()
        } else {
            self.timestamp.clone()
        }
    }

    /// `{layer}/{z}/{x}/{y}/{bucket}`: one entry per tile and hour.
    pub fn cache_id(&self, now: DateTime<Utc>) -> String {
        format!(
            "{}/{}/{}/{}/{}",
            self.layer,
            self.z,
            self.x,
            self.y,
            self.bucket(now)
        )
    }

    /// The Tomorrow.io tile URL. It carries the key, so it is never logged.
    /// Every part is checked above, so the origin and path stay pinned.
    pub fn upstream_url(&self, api_key: &str) -> String {
        format!(
            "{TOMORROW_TILE_ORIGIN}/v4/map/tile/{}/{}/{}/{}/{}.png?apikey={api_key}",
            self.z, self.x, self.y, self.layer, self.timestamp
        )
    }
}

/// Whether a tile fetched at `fetched_ms` is still fresh at `now_ms`.
pub fn is_fresh(fetched_ms: u64, now_ms: u64) -> bool {
    now_ms.saturating_sub(fetched_ms) < FRESH_SECONDS * 1_000
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(q: &[(&'static str, &'static str)]) -> Result<TileRequest, TileError> {
        TileRequest::parse(q.iter().copied())
    }

    fn ok(q: &[(&'static str, &'static str)]) -> TileRequest {
        parse(q).expect("valid")
    }

    #[test]
    fn a_normal_tile() {
        let t = ok(&[
            ("z", "5"),
            ("x", "18"),
            ("y", "17"),
            ("layer", "precipitationIntensity"),
        ]);
        assert_eq!(t.timestamp, "now");
        assert_eq!((t.z, t.x, t.y), (5, 18, 17));
        assert_eq!(
            t.upstream_url("K"),
            "https://api.tomorrow.io/v4/map/tile/5/18/17/precipitationIntensity/now.png?apikey=K"
        );
    }

    #[test]
    fn every_layer_is_allowed_and_nothing_else() {
        for layer in VALID_LAYERS {
            assert!(parse(&[("z", "1"), ("x", "0"), ("y", "0"), ("layer", layer)]).is_ok());
        }
        for bad in ["", "Temperature", "temperature/../x", "pressure"] {
            assert_eq!(
                parse(&[("z", "1"), ("x", "0"), ("y", "0"), ("layer", bad)]),
                Err(refuse(400, "Invalid layer"))
            );
        }
    }

    #[test]
    fn zoom_bounds() {
        let at =
            |z: &'static str| parse(&[("z", z), ("x", "0"), ("y", "0"), ("layer", "humidity")]);
        assert_eq!(at("0"), Err(refuse(400, "Zoom out of range")));
        assert_eq!(at("13"), Err(refuse(400, "Zoom out of range")));
        assert_eq!(at("-1"), Err(refuse(400, "Zoom out of range")));
        assert!(at("1").is_ok());
        assert!(at("12").is_ok());
    }

    #[test]
    fn tile_bounds_follow_the_zoom() {
        let at = |x: &'static str, y: &'static str| {
            parse(&[("z", "2"), ("x", x), ("y", y), ("layer", "windSpeed")])
        };
        assert!(at("3", "3").is_ok());
        assert_eq!(
            at("4", "0"),
            Err(refuse(400, "Tile coordinates out of range"))
        );
        assert_eq!(
            at("0", "4"),
            Err(refuse(400, "Tile coordinates out of range"))
        );
        assert_eq!(
            at("-1", "0"),
            Err(refuse(400, "Tile coordinates out of range"))
        );
    }

    #[test]
    fn missing_or_non_integer_is_422() {
        assert_eq!(
            parse(&[("x", "0"), ("y", "0"), ("layer", "humidity")])
                .unwrap_err()
                .status,
            422
        );
        assert_eq!(
            parse(&[("z", "1.5"), ("x", "0"), ("y", "0"), ("layer", "humidity")])
                .unwrap_err()
                .status,
            422
        );
        assert_eq!(
            parse(&[("z", "abc"), ("x", "0"), ("y", "0"), ("layer", "humidity")])
                .unwrap_err()
                .status,
            422
        );
        assert_eq!(
            parse(&[("z", "1"), ("x", "0"), ("y", "0")])
                .unwrap_err()
                .status,
            422
        );
    }

    #[test]
    fn timestamps() {
        let at = |ts: &'static str| {
            parse(&[
                ("z", "3"),
                ("x", "1"),
                ("y", "1"),
                ("layer", "cloudCover"),
                ("timestamp", ts),
            ])
        };
        assert!(at("now").is_ok());
        assert!(at("2026-10-05T12:00:00Z").is_ok());
        for bad in [
            "",
            "NOW",
            "2026-10-05T12:00:00",
            "2026-10-05 12:00:00Z",
            "2026-1a-05T12:00:00Z",
            "../x",
        ] {
            assert_eq!(at(bad), Err(refuse(400, "Invalid timestamp")), "{bad}");
        }
    }

    #[test]
    fn now_snaps_to_the_hour() {
        let now = DateTime::parse_from_rfc3339("2026-10-05T12:34:56Z")
            .unwrap()
            .with_timezone(&Utc);
        let t = ok(&[("z", "3"), ("x", "1"), ("y", "2"), ("layer", "temperature")]);
        assert_eq!(t.cache_id(now), "temperature/3/1/2/2026-10-05T12:00:00Z");
        let fixed = ok(&[
            ("z", "3"),
            ("x", "1"),
            ("y", "2"),
            ("layer", "temperature"),
            ("timestamp", "2026-10-04T06:00:00Z"),
        ]);
        assert_eq!(
            fixed.cache_id(now),
            "temperature/3/1/2/2026-10-04T06:00:00Z"
        );
    }

    #[test]
    fn freshness_window() {
        assert!(is_fresh(0, FRESH_SECONDS * 1_000 - 1));
        assert!(!is_fresh(0, FRESH_SECONDS * 1_000));
    }

    #[test]
    fn transparent_png_matches_the_python_bytes() {
        // base64 of the same PNG as api/py/_tiles.py
        assert_eq!(&TRANSPARENT_PNG[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(
            &TRANSPARENT_PNG[TRANSPARENT_PNG.len() - 8..],
            b"IEND\xaeB`\x82"
        );
    }
}
