//! WMO 4677 weather codes: the Tomorrow.io mapping and plain-language labels.

/// Map a Tomorrow.io weather code to a WMO 4677 code.
///
/// The single canonical mapping (#101), ported unchanged from
/// `api/py/_weather.py::_tomorrow_code_to_wmo`. Unknown codes map to 0.
pub fn tomorrow_to_wmo(code: i64) -> i64 {
    match code {
        1000 => 0,  // Clear, Sunny
        1100 => 1,  // Mostly Clear
        1101 => 2,  // Partly Cloudy
        1102 => 3,  // Mostly Cloudy
        1001 => 3,  // Cloudy
        2000 => 45, // Fog
        2100 => 45, // Light Fog
        4000 => 51, // Drizzle
        4001 => 63, // Rain
        4200 => 61, // Light Rain
        4201 => 65, // Heavy Rain
        5000 => 73, // Snow
        5001 => 71, // Flurries
        5100 => 71, // Light Snow
        5101 => 75, // Heavy Snow
        6000 => 66, // Freezing Drizzle
        6001 => 67, // Freezing Rain
        6200 => 66, // Light Freezing Rain
        6201 => 67, // Heavy Freezing Rain
        7000 => 77, // Ice Pellets
        7101 => 77, // Heavy Ice Pellets
        7102 => 77, // Light Ice Pellets
        8000 => 95, // Thunderstorm
        _ => 0,
    }
}

/// Plain-language label for a WMO code, matching `weatherCodeToInfo` in
/// `src/lib/weather.ts` so the app and the API describe a day the same way.
pub fn description(code: i64) -> &'static str {
    match code {
        0 => "Clear sky",
        1 => "Mainly clear",
        2 => "Partly cloudy",
        3 => "Overcast",
        45 => "Fog",
        48 => "Depositing rime fog",
        51 => "Light drizzle",
        53 => "Moderate drizzle",
        55 => "Dense drizzle",
        61 => "Slight rain",
        63 => "Moderate rain",
        65 => "Heavy rain",
        66 => "Light freezing rain",
        67 => "Heavy freezing rain",
        71 => "Slight snow",
        73 => "Moderate snow",
        75 => "Heavy snow",
        77 => "Snow grains",
        80 => "Slight rain showers",
        81 => "Moderate rain showers",
        82 => "Violent rain showers",
        85 => "Slight snow showers",
        86 => "Heavy snow showers",
        95 => "Thunderstorm",
        96 => "Thunderstorm with slight hail",
        99 => "Thunderstorm with heavy hail",
        _ => "Unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tomorrow_codes_follow_the_documented_labels() {
        assert_eq!(tomorrow_to_wmo(4200), 61, "Light Rain is slight rain");
        assert_eq!(tomorrow_to_wmo(4001), 63, "Rain is moderate rain");
        assert_eq!(tomorrow_to_wmo(5100), 71);
        assert_eq!(tomorrow_to_wmo(8000), 95);
        assert_eq!(tomorrow_to_wmo(123_456), 0);
    }

    #[test]
    fn every_mapped_code_has_a_label() {
        for code in [
            1000, 1100, 1101, 1102, 1001, 2000, 2100, 4000, 4001, 4200, 4201, 5000, 5001, 5100,
            5101, 6000, 6001, 6200, 6201, 7000, 7101, 7102, 8000,
        ] {
            assert_ne!(description(tomorrow_to_wmo(code)), "Unknown", "{code}");
        }
        assert_eq!(description(42), "Unknown");
    }
}
