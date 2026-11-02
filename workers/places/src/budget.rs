//! The hourly geocoder budgets live in `weather_edge::budget`, shared with the
//! AI Worker. This keeps the Worker's own paths (`crate::budget`) unchanged.

pub use weather_edge::budget::*;
