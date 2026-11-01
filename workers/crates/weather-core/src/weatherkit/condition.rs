//! WeatherKit `conditionCode` to a WMO 4677 weather code.
//!
//! The standards rule: the app speaks WMO codes (the subset Open-Meteo emits
//! and `crate::wmo::description` names), never a provider's strings. This is
//! the WeatherKit counterpart of [`crate::wmo::tomorrow_to_wmo`], and where the
//! two providers mean the same thing it gives the same code (Drizzle 51, Rain
//! 63, Heavy rain 65, Flurries 71, Snow 73, Heavy snow 75, Freezing drizzle 66,
//! Freezing rain 67, Sleet 77 as Tomorrow.io's ice pellets).
//!
//! Apple documents 34 condition codes (the cases of Swift's `WeatherCondition`;
//! the REST API sends them as UpperCamelCase strings such as `PartlyCloudy`).
//! [`DOCUMENTED`] lists them all and the tests pin every one.
//!
//! **A code with no honest equivalent is `None`, never `0`.** Apple names nine
//! conditions that describe the air, the wind or the temperature rather than the
//! sky or the precipitation (haze, smoke, blowing dust, breezy, windy, frigid,
//! hot, tropical storm, hurricane). No code in our set means any of them, and
//! `0` would say "clear sky". `None` leaves that hour to the filler (the
//! single-model baseline fills what the model does not publish from
//! `best_match`), and wind, heat and cold reach the app through their own
//! variables.

/// Every `conditionCode` Apple documents for the WeatherKit REST API (the 34
/// cases of `WeatherCondition`), in the order Apple groups them.
pub const DOCUMENTED: [&str; 34] = [
    // Visibility.
    "BlowingDust",
    "Clear",
    "Cloudy",
    "Foggy",
    "Haze",
    "MostlyClear",
    "MostlyCloudy",
    "PartlyCloudy",
    "Smoky",
    // Wind.
    "Breezy",
    "Windy",
    // Precipitation.
    "Drizzle",
    "HeavyRain",
    "IsolatedThunderstorms",
    "Rain",
    "SunShowers",
    "ScatteredThunderstorms",
    "StrongStorms",
    "Thunderstorms",
    // Hazardous.
    "Frigid",
    "Hail",
    "Hot",
    // Winter precipitation.
    "Flurries",
    "Sleet",
    "Snow",
    "SunFlurries",
    "WintryMix",
    // Hazardous winter.
    "Blizzard",
    "BlowingSnow",
    "FreezingDrizzle",
    "FreezingRain",
    "HeavySnow",
    // Tropical.
    "Hurricane",
    "TropicalStorm",
];

/// `Clear` -> `clear`, `partly_cloudy` -> `partlycloudy`: lower case with
/// everything that is not a letter or digit dropped, so `PartlyCloudy`,
/// `partlyCloudy` and `PARTLY_CLOUDY` are one code. Apple's REST strings are
/// UpperCamelCase; the Swift enum is lowerCamelCase.
fn key(code: &str) -> String {
    code.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// The WMO 4677 code for a WeatherKit `conditionCode`, or `None` when Apple
/// names something no code in our set means (see the module docs) or the string
/// is not a documented code.
pub fn to_wmo(code: &str) -> Option<u8> {
    match key(code).as_str() {
        // Sky.
        "clear" => Some(0),
        "mostlyclear" => Some(1),
        "partlycloudy" => Some(2),
        // WMO has no "mostly cloudy"; overcast (3) is the nearest, as for
        // Tomorrow.io's Mostly Cloudy.
        "mostlycloudy" | "cloudy" => Some(3),
        "foggy" => Some(45),
        // Rain.
        "drizzle" => Some(51),
        "rain" => Some(63),
        "heavyrain" => Some(65),
        // Rain with the sun out: a shower (80, slight rain showers).
        "sunshowers" => Some(80),
        // Thunder. Apple's variants differ in coverage, not in kind, and
        // "strong" does not say hail, so none of them claims hail.
        "isolatedthunderstorms" | "scatteredthunderstorms" | "thunderstorms" | "strongstorms" => {
            Some(95)
        }
        // Hail alone has no code in our set; 96 (thunderstorm with slight
        // hail) is the nearest, and hail comes from a thunderstorm.
        "hail" => Some(96),
        // Snow.
        "flurries" => Some(71),
        "snow" => Some(73),
        "heavysnow" | "blizzard" => Some(75),
        // Snow showers with the sun out: 85 (slight snow showers).
        "sunflurries" => Some(85),
        // Drifting snow moves snow that may not be falling: a moderate snowfall
        // is the nearest picture.
        "blowingsnow" => Some(73),
        // Freezing precipitation and ice.
        "freezingdrizzle" => Some(66),
        "freezingrain" => Some(67),
        // Sleet is ice pellets (Tomorrow.io's ice pellets are 77 as well).
        "sleet" => Some(77),
        // A mix of rain, snow and sleet: the freezing-precipitation hazard is
        // what matters, at its lightest.
        "wintrymix" => Some(66),
        // Air, wind and temperature descriptors, and cyclones: nothing in our
        // set means them. See the module docs.
        "haze" | "smoky" | "blowingdust" | "breezy" | "windy" | "frigid" | "hot"
        | "tropicalstorm" | "hurricane" => None,
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wmo;

    /// The mapping, written out by hand (not derived from the function), one
    /// row for each documented code.
    const EXPECTED: [(&str, Option<u8>); 34] = [
        ("BlowingDust", None),
        ("Clear", Some(0)),
        ("Cloudy", Some(3)),
        ("Foggy", Some(45)),
        ("Haze", None),
        ("MostlyClear", Some(1)),
        ("MostlyCloudy", Some(3)),
        ("PartlyCloudy", Some(2)),
        ("Smoky", None),
        ("Breezy", None),
        ("Windy", None),
        ("Drizzle", Some(51)),
        ("HeavyRain", Some(65)),
        ("IsolatedThunderstorms", Some(95)),
        ("Rain", Some(63)),
        ("SunShowers", Some(80)),
        ("ScatteredThunderstorms", Some(95)),
        ("StrongStorms", Some(95)),
        ("Thunderstorms", Some(95)),
        ("Frigid", None),
        ("Hail", Some(96)),
        ("Hot", None),
        ("Flurries", Some(71)),
        ("Sleet", Some(77)),
        ("Snow", Some(73)),
        ("SunFlurries", Some(85)),
        ("WintryMix", Some(66)),
        ("Blizzard", Some(75)),
        ("BlowingSnow", Some(73)),
        ("FreezingDrizzle", Some(66)),
        ("FreezingRain", Some(67)),
        ("HeavySnow", Some(75)),
        ("Hurricane", None),
        ("TropicalStorm", None),
    ];

    #[test]
    fn every_documented_code_maps_as_written() {
        assert_eq!(DOCUMENTED.len(), 34);
        for (code, want) in EXPECTED {
            assert_eq!(to_wmo(code), want, "{code}");
        }
        // The hand-written table covers exactly the documented list, in order.
        let listed: Vec<&str> = EXPECTED.iter().map(|(c, _)| *c).collect();
        assert_eq!(listed, DOCUMENTED.to_vec());
    }

    #[test]
    fn no_documented_code_is_missing_or_duplicated() {
        let mut seen = std::collections::BTreeSet::new();
        for c in DOCUMENTED {
            assert!(seen.insert(key(c)), "{c} is listed twice");
        }
        assert_eq!(seen.len(), 34);
    }

    #[test]
    fn a_code_that_means_nothing_to_us_is_none_never_zero() {
        // 0 is "clear sky": haze, wind and heat must not become it.
        for c in [
            "Haze",
            "Smoky",
            "BlowingDust",
            "Breezy",
            "Windy",
            "Frigid",
            "Hot",
            "TropicalStorm",
            "Hurricane",
        ] {
            assert_eq!(to_wmo(c), None, "{c}");
        }
        assert_eq!(to_wmo(""), None);
        assert_eq!(to_wmo("NotACondition"), None);
        assert_eq!(to_wmo("0"), None);
        // Only Clear is 0.
        let zeros: Vec<&str> = DOCUMENTED
            .iter()
            .copied()
            .filter(|c| to_wmo(c) == Some(0))
            .collect();
        assert_eq!(zeros, vec!["Clear"]);
    }

    #[test]
    fn the_spelling_style_does_not_matter() {
        // The REST API is UpperCamelCase, the Swift enum lowerCamelCase.
        assert_eq!(to_wmo("PartlyCloudy"), Some(2));
        assert_eq!(to_wmo("partlyCloudy"), Some(2));
        assert_eq!(to_wmo("partly_cloudy"), Some(2));
        assert_eq!(to_wmo(" PARTLY CLOUDY "), Some(2));
        assert_eq!(to_wmo("heavyRain"), Some(65));
    }

    #[test]
    fn every_code_we_emit_is_one_the_app_can_describe() {
        for c in DOCUMENTED {
            if let Some(code) = to_wmo(c) {
                assert_ne!(
                    wmo::description(i64::from(code)),
                    "Unknown",
                    "{c} maps to WMO {code}, which the app cannot describe"
                );
            }
        }
    }

    #[test]
    fn where_tomorrow_io_means_the_same_it_gives_the_same_code() {
        // One canonical mapping per meaning (#101).
        for (apple, tomorrow) in [
            ("Clear", 1000),
            ("MostlyClear", 1100),
            ("PartlyCloudy", 1101),
            ("MostlyCloudy", 1102),
            ("Cloudy", 1001),
            ("Foggy", 2000),
            ("Drizzle", 4000),
            ("Rain", 4001),
            ("HeavyRain", 4201),
            ("Snow", 5000),
            ("Flurries", 5001),
            ("HeavySnow", 5101),
            ("FreezingDrizzle", 6000),
            ("FreezingRain", 6001),
            ("Sleet", 7000),
            ("Thunderstorms", 8000),
        ] {
            assert_eq!(
                to_wmo(apple).map(i64::from),
                Some(wmo::tomorrow_to_wmo(tomorrow)),
                "{apple}"
            );
        }
    }
}
