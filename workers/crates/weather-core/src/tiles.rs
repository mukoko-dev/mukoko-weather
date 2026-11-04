//! Weather map overlay tiles, ported from `api/py/_tiles.py`
//! (Python `/map-tiles`).
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

/// Short caching for a stale tile (a real image, an hour or more old), so
/// browsers pick up the fresh one soon after the provider recovers.
pub const FALLBACK_CACHE_CONTROL: &str = "public, max-age=300";

/// A short caching for the empty tile. It says nothing about the place: only
/// that the provider could not be asked at that moment. Kept for five minutes
/// by a browser, a failed request during a quota or breaker window became a
/// blank tile that stayed blank after the provider had recovered, and every
/// zoom back to that area re-used it. But not `no-store` either: while a quota
/// is spent, a browser asking again on every pan would send each ask on to the
/// provider, and the only brake on that is a per-isolate breaker, so the empty
/// tile is kept for thirty seconds.
pub const EMPTY_CACHE_CONTROL: &str = "public, max-age=30";

/// Which kind of tile a response carries, for its `Cache-Control`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TileKind {
    /// A real tile the provider (or our cache) just gave.
    Fresh,
    /// A real tile, an hour or more old, served because the provider failed.
    Stale,
    /// The transparent stand-in: nothing could be served.
    Empty,
}

/// The `Cache-Control` of a response, by what it carries. The longer a thing
/// is true, the longer it may be kept: a fresh tile for an hour, a stale one
/// for five minutes, the empty stand-in for thirty seconds.
pub fn cache_control(kind: TileKind) -> &'static str {
    match kind {
        TileKind::Fresh => TILE_CACHE_CONTROL,
        TileKind::Stale => FALLBACK_CACHE_CONTROL,
        TileKind::Empty => EMPTY_CACHE_CONTROL,
    }
}

/// A 1x1 fully transparent PNG (8-bit RGBA, one all-zero pixel), served
/// (HTTP 200) when the provider fails and no cached tile exists, so the map
/// shows no overlay for that tile.
///
/// It must be a PNG a browser really decodes: `createImageBitmap` (MapLibre's
/// tile path) rejects a file with a wrong chunk CRC or a truncated zlib stream,
/// and the map then reports a failed overlay tile for every step of the
/// timeline.
/// The tests walk the chunks, check every CRC-32 and inflate the image data.
pub const TRANSPARENT_PNG: [u8; 68] = [
    // signature
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, //
    // IHDR (13): 1 x 1, bit depth 8, colour type 6 (RGBA), deflate, adaptive filter, no interlace
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, //
    // IDAT (11): zlib stream of filter byte 0 + four zero bytes, then its Adler-32
    0x00, 0x00, 0x00, 0x0B, 0x49, 0x44, 0x41, 0x54, 0x78, 0xDA, 0x63, 0x60, 0x00, 0x02, 0x00, 0x00,
    0x05, 0x00, 0x01, 0xE9, 0xFA, 0xDC, 0xD8, //
    // IEND
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
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
    let shaped = b.len() == 20
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            10 => *c == b'T',
            13 | 16 => *c == b':',
            19 => *c == b'Z',
            _ => c.is_ascii_digit(),
        });
    if !shaped {
        return false;
    }
    // The shape is not enough: Tomorrow.io answers 4xx for 2024-99-99, and a
    // request it rejects must never reach it. The date has to exist, and sit
    // in a window a forecast tile can plausibly be asked for.
    let field = |a: usize, z: usize| s[a..z].parse::<u32>().ok();
    let (Some(year), Some(month), Some(day)) = (field(0, 4), field(5, 7), field(8, 10)) else {
        return false;
    };
    let (Some(hour), Some(minute), Some(second)) = (field(11, 13), field(14, 16), field(17, 19))
    else {
        return false;
    };
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (2020..=2100).contains(&year)
        && (1..=days).contains(&day)
        && hour < 24
        && minute < 60
        && second < 60
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

    /// The `max-age` of a `Cache-Control` value, in seconds.
    fn max_age(value: &str) -> u64 {
        value
            .split(',')
            .filter_map(|d| d.trim().strip_prefix("max-age="))
            .next()
            .and_then(|n| n.parse().ok())
            .expect("a max-age")
    }

    #[test]
    fn the_less_a_tile_says_the_less_a_cache_keeps_it() {
        // Fresh tile > stale tile > the empty stand-in, and the empty one is
        // short but not zero: a browser that asked again on every pan would
        // send each ask on to a provider whose quota is already spent.
        let fresh = max_age(cache_control(TileKind::Fresh));
        let stale = max_age(cache_control(TileKind::Stale));
        let empty = max_age(cache_control(TileKind::Empty));
        assert!(fresh > stale, "{fresh} > {stale}");
        assert!(stale > empty, "{stale} > {empty}");
        assert!(empty > 0 && empty <= 60, "{empty}");
        // The empty tile must be cacheable only briefly; never shared long.
        assert!(!cache_control(TileKind::Empty).contains("s-maxage"));
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
    fn tile_timestamp_rejects_impossible_dates() {
        let at = |ts: &'static str| {
            parse(&[
                ("z", "3"),
                ("x", "1"),
                ("y", "1"),
                ("layer", "humidity"),
                ("timestamp", ts),
            ])
        };
        for bad in [
            "2024-99-99T99:99:99Z",
            "0000-00-00T00:00:00Z",
            "9999-12-31T25:61:61Z",
            "2023-02-29T00:00:00Z",
            "2024-04-31T00:00:00Z",
            "2024-13-01T00:00:00Z",
            "2024-01-01T24:00:00Z",
            "1969-12-31T23:59:59Z",
            "9999-12-31T23:59:59Z",
            "2019-12-31T23:59:59Z",
            "2101-01-01T00:00:00Z",
        ] {
            assert_eq!(at(bad), Err(refuse(400, "Invalid timestamp")), "{bad}");
        }
        for good in [
            "now",
            "2024-02-29T00:00:00Z",
            "2028-02-29T12:30:45Z",
            "2026-10-31T23:59:59Z",
        ] {
            assert!(at(good).is_ok(), "{good}");
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

    // ---- The fallback tile must be a PNG a browser decodes ----------------
    //
    // The first version of the constant had the right signature and the right
    // last eight bytes, and passed a test that checked only those, but its
    // IDAT length, CRC and zlib stream were wrong: Chromium's
    // `createImageBitmap` refused it. These helpers check the whole file the
    // way a decoder does, with no dependency beyond `miniz_oxide`.

    /// CRC-32 as PNG defines it (ISO 3309, polynomial 0xEDB88320, reflected).
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFF_u32;
        for &b in bytes {
            crc ^= u32::from(b);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    /// Adler-32, the checksum that ends a zlib stream (RFC 1950).
    fn adler32(bytes: &[u8]) -> u32 {
        let (mut a, mut b) = (1_u32, 0_u32);
        for &x in bytes {
            a = (a + u32::from(x)) % 65_521;
            b = (b + a) % 65_521;
        }
        (b << 16) | a
    }

    /// One PNG chunk: its type, its data and the CRC the file stores for it.
    struct Chunk<'a> {
        kind: [u8; 4],
        data: &'a [u8],
        stored_crc: u32,
    }

    impl Chunk<'_> {
        /// CRC-32 over the type and the data, as the PNG spec says.
        fn computed_crc(&self) -> u32 {
            let mut covered = self.kind.to_vec();
            covered.extend_from_slice(self.data);
            crc32(&covered)
        }
    }

    /// Walk the file strictly: the signature, then chunks that each fit, and
    /// nothing left over. A chunk length that points past the end, or bytes
    /// after the last chunk, are errors (the old constant failed both).
    fn chunks(png: &[u8]) -> Result<Vec<Chunk<'_>>, String> {
        const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
        if png.get(..8) != Some(SIGNATURE) {
            return Err("bad PNG signature".into());
        }
        let be32 = |at: usize| -> Option<u32> {
            let b: [u8; 4] = png.get(at..at + 4)?.try_into().ok()?;
            Some(u32::from_be_bytes(b))
        };
        let mut out = Vec::new();
        let mut at = 8;
        while at < png.len() {
            let len = be32(at).ok_or("truncated chunk length")? as usize;
            let kind: [u8; 4] = png
                .get(at + 4..at + 8)
                .and_then(|k| k.try_into().ok())
                .ok_or("truncated chunk type")?;
            let end = (at + 8).checked_add(len).ok_or("chunk length overflows")?;
            let data = png
                .get(at + 8..end)
                .ok_or_else(|| format!("chunk {kind:?} runs past the end of the file"))?;
            let stored_crc = be32(end).ok_or("truncated chunk CRC")?;
            out.push(Chunk {
                kind,
                data,
                stored_crc,
            });
            at = end + 4;
        }
        if at != png.len() {
            return Err("bytes after the last chunk".into());
        }
        Ok(out)
    }

    #[test]
    fn the_crc_and_adler_helpers_match_published_vectors() {
        // So the PNG tests below cannot pass because the helpers are wrong.
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b"IEND"), 0xAE42_6082, "the CRC every PNG ends with");
        assert_eq!(adler32(b"Wikipedia"), 0x11E6_0398);
        assert_eq!(adler32(&[0; 5]), 0x0005_0001);
    }

    #[test]
    fn transparent_png_is_a_well_formed_png() {
        let parsed = chunks(&TRANSPARENT_PNG).expect("signature and chunk layout");
        let kinds: Vec<&[u8]> = parsed.iter().map(|c| c.kind.as_slice()).collect();
        assert_eq!(kinds, [b"IHDR".as_slice(), b"IDAT", b"IEND"]);
        for c in &parsed {
            assert_eq!(
                c.stored_crc,
                c.computed_crc(),
                "CRC-32 of the {} chunk",
                String::from_utf8_lossy(&c.kind)
            );
        }
        assert!(parsed[2].data.is_empty(), "IEND carries no data");
    }

    #[test]
    fn transparent_png_is_one_rgba_pixel() {
        let parsed = chunks(&TRANSPARENT_PNG).expect("chunk layout");
        let ihdr = parsed[0].data;
        assert_eq!(ihdr.len(), 13, "IHDR is 13 bytes");
        assert_eq!(&ihdr[0..4], 1_u32.to_be_bytes(), "width");
        assert_eq!(&ihdr[4..8], 1_u32.to_be_bytes(), "height");
        assert_eq!(ihdr[8], 8, "bit depth");
        assert_eq!(
            ihdr[9], 6,
            "colour type 6 is RGBA, so it has an alpha channel"
        );
        assert_eq!(ihdr[10], 0, "compression method: deflate");
        assert_eq!(ihdr[11], 0, "filter method: adaptive");
        assert_eq!(ihdr[12], 0, "no interlace");
    }

    #[test]
    fn transparent_png_pixels_inflate_to_one_clear_pixel() {
        let parsed = chunks(&TRANSPARENT_PNG).expect("chunk layout");
        let idat: Vec<u8> = parsed
            .iter()
            .filter(|c| &c.kind == b"IDAT")
            .flat_map(|c| c.data.iter().copied())
            .collect();
        // RFC 1950 header: deflate with a window up to 32 KiB, and the two
        // header bytes together a multiple of 31.
        assert_eq!(idat[0] & 0x0F, 8, "zlib compression method is deflate");
        assert_eq!((u32::from(idat[0]) << 8 | u32::from(idat[1])) % 31, 0);
        // The whole stream inflates (miniz_oxide also checks the Adler-32)...
        let raw = miniz_oxide::inflate::decompress_to_vec_zlib(&idat)
            .expect("the image data is a complete zlib stream");
        // ...to one scanline: filter type 0 and R, G, B, A all zero. Alpha 0
        // is what makes the tile show no overlay.
        assert_eq!(raw, [0_u8; 5]);
        // ...and the stream's own checksum is right, checked here without the
        // library so the two do not share a blind spot.
        let trailer = idat.len().checked_sub(4).map(|i| &idat[i..]);
        assert_eq!(trailer, Some(adler32(&raw).to_be_bytes().as_slice()));
    }
}
