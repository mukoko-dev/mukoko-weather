//! Validating forecast query strings, shared by the internal and public APIs
//! so both reject the same inputs the same way.

use std::fmt;

/// Where a forecast is for.
#[derive(Debug, Clone, PartialEq)]
pub enum PlaceQuery {
    /// A slug or a name, e.g. `harare` or `Victoria Falls`.
    Named(String),
    /// A coordinate pair.
    Point { lat: f64, lon: f64 },
}

/// A validated `GET /internal/forecast` (or `/v1/forecast`) request.
#[derive(Debug, Clone, PartialEq)]
pub struct ForecastQuery {
    pub place: PlaceQuery,
    /// 1 to 7 days.
    pub days: u8,
}

/// Why a query was refused. Every variant is a `422` except where noted.
#[derive(Debug, Clone, PartialEq)]
pub enum QueryError {
    MissingPlace,
    LocationTooLong,
    BadNumber(&'static str),
    OutOfRange(&'static str),
}

impl fmt::Display for QueryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            QueryError::MissingPlace => write!(f, "Give `location`, or both `lat` and `lon`."),
            QueryError::LocationTooLong => write!(f, "`location` is at most 80 characters."),
            QueryError::BadNumber(p) => write!(f, "`{p}` must be a number."),
            QueryError::OutOfRange(p) => match *p {
                "lat" => write!(f, "`lat` must be between -90 and 90."),
                "lon" => write!(f, "`lon` must be between -180 and 180."),
                _ => write!(f, "`days` must be between 1 and 7."),
            },
        }
    }
}

pub const MAX_DAYS: u8 = 7;
const MAX_LOCATION_CHARS: usize = 80;

impl ForecastQuery {
    /// Parse from decoded query pairs. `location` wins when both a location
    /// and a point are given, as in the Nyuchi API.
    pub fn parse<'a, I>(pairs: I) -> Result<Self, QueryError>
    where
        I: IntoIterator<Item = (&'a str, &'a str)>,
    {
        let (mut location, mut lat, mut lon, mut days) = (None, None, None, None);
        for (k, v) in pairs {
            match k {
                "location" => location = Some(v),
                "lat" => lat = Some(v),
                "lon" => lon = Some(v),
                "days" => days = Some(v),
                _ => {}
            }
        }

        let days = match days {
            None | Some("") => MAX_DAYS,
            Some(d) => {
                let n: i64 = d
                    .trim()
                    .parse()
                    .map_err(|_| QueryError::BadNumber("days"))?;
                if !(1..=i64::from(MAX_DAYS)).contains(&n) {
                    return Err(QueryError::OutOfRange("days"));
                }
                n as u8
            }
        };

        let number = |name: &'static str, v: &str| -> Result<f64, QueryError> {
            let x: f64 = v.trim().parse().map_err(|_| QueryError::BadNumber(name))?;
            if x.is_finite() {
                Ok(x)
            } else {
                Err(QueryError::BadNumber(name))
            }
        };
        let lat = lat
            .filter(|s| !s.is_empty())
            .map(|v| number("lat", v))
            .transpose()?;
        let lon = lon
            .filter(|s| !s.is_empty())
            .map(|v| number("lon", v))
            .transpose()?;
        if let Some(lat) = lat {
            if !(-90.0..=90.0).contains(&lat) {
                return Err(QueryError::OutOfRange("lat"));
            }
        }
        if let Some(lon) = lon {
            if !(-180.0..=180.0).contains(&lon) {
                return Err(QueryError::OutOfRange("lon"));
            }
        }

        if let Some(loc) = location.map(str::trim).filter(|s| !s.is_empty()) {
            if loc.chars().count() > MAX_LOCATION_CHARS {
                return Err(QueryError::LocationTooLong);
            }
            return Ok(ForecastQuery {
                place: PlaceQuery::Named(loc.to_owned()),
                days,
            });
        }
        match (lat, lon) {
            (Some(lat), Some(lon)) => Ok(ForecastQuery {
                place: PlaceQuery::Point { lat, lon },
                days,
            }),
            _ => Err(QueryError::MissingPlace),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(q: &[(&str, &str)]) -> Result<ForecastQuery, QueryError> {
        ForecastQuery::parse(q.iter().copied())
    }

    #[test]
    fn a_location_defaults_to_seven_days() {
        let q = parse(&[("location", "harare")]).unwrap();
        assert_eq!(q.place, PlaceQuery::Named("harare".into()));
        assert_eq!(q.days, 7);
    }

    #[test]
    fn a_point_with_days() {
        let q = parse(&[("lat", "-17.8"), ("lon", "31.05"), ("days", "3")]).unwrap();
        assert_eq!(
            q.place,
            PlaceQuery::Point {
                lat: -17.8,
                lon: 31.05
            }
        );
        assert_eq!(q.days, 3);
    }

    #[test]
    fn location_wins_over_a_point() {
        let q = parse(&[("location", "bulawayo"), ("lat", "1"), ("lon", "2")]).unwrap();
        assert_eq!(q.place, PlaceQuery::Named("bulawayo".into()));
    }

    #[test]
    fn bad_inputs_are_refused() {
        assert_eq!(parse(&[]), Err(QueryError::MissingPlace));
        assert_eq!(parse(&[("lat", "1")]), Err(QueryError::MissingPlace));
        assert_eq!(parse(&[("location", "  ")]), Err(QueryError::MissingPlace));
        assert_eq!(
            parse(&[("lat", "x"), ("lon", "1")]),
            Err(QueryError::BadNumber("lat"))
        );
        assert_eq!(
            parse(&[("lat", "NaN"), ("lon", "1")]),
            Err(QueryError::BadNumber("lat"))
        );
        assert_eq!(
            parse(&[("lat", "91"), ("lon", "1")]),
            Err(QueryError::OutOfRange("lat"))
        );
        assert_eq!(
            parse(&[("lat", "1"), ("lon", "181")]),
            Err(QueryError::OutOfRange("lon"))
        );
        assert_eq!(
            parse(&[("location", "x"), ("days", "0")]),
            Err(QueryError::OutOfRange("days"))
        );
        assert_eq!(
            parse(&[("location", "x"), ("days", "8")]),
            Err(QueryError::OutOfRange("days"))
        );
        assert_eq!(
            parse(&[("location", "x"), ("days", "two")]),
            Err(QueryError::BadNumber("days"))
        );
        let long = "a".repeat(81);
        assert_eq!(
            parse(&[("location", &long)]),
            Err(QueryError::LocationTooLong)
        );
    }
}
