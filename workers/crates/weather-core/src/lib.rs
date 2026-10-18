//! Pure weather logic shared by every Mukoko Weather Worker.
//!
//! Nothing in this crate touches the network, a clock or a Worker binding, so
//! it builds and tests natively (`cargo test -p weather-core`) as well as for
//! `wasm32-unknown-unknown`. The Workers pass in what they fetched and the
//! current time, and get back the shapes they serve.
//!
//! The logic is ported from the Python backend (`api/py/`), keeping its
//! behaviour: the single Tomorrow.io to WMO map (#101), the Open-Meteo
//! request, the StationKit blending rule, the QC ranges and the station
//! ingest-key hashing.

pub mod ai;
pub mod air_quality;
pub mod aq_grid;
pub mod auth;
pub mod aviation;
pub mod breaker;
pub mod budget;
pub mod cache;
pub mod cors;
pub mod devkey;
pub mod enso;
pub mod forecast;
pub mod geo;
pub mod haze;
pub mod jobs;
pub mod locations;
pub mod model_grid;
pub mod normalize;
pub mod normals;
pub mod places;
pub mod push;
pub mod query;
pub mod reference;
pub mod resolve;
pub mod secrets;
pub mod sg_air;
pub mod station;
pub mod tiles;
pub mod wmo;

pub use forecast::{ForecastDay, ForecastLocation, ForecastResponse, Source};
pub use places::Place;
pub use query::{ForecastQuery, PlaceQuery, QueryError};
