//! `mukoko-weather-forecast`: provider aggregation.
//!
//! The only Worker that talks to forecast providers. It has no route and no
//! workers.dev address: the API Workers reach it through service bindings.
//!
//! ```text
//! GET /weather?lat=&lon=[&models=a,b][&extras=1][&refresh=1]   full WeatherData (the app's shape)
//! GET /daily?location=|lat=&lon=[&days=1..7]       the daily forecast contract
//! GET /air-quality?lat=&lon=                       the EPA AQI (Open-Meteo air quality)
//! GET /health                                      which bindings are configured
//! ```
//!
//! Provider chain (ported from `api/py/_weather.py`): KV cache (15 min), then
//! Tomorrow.io, then Open-Meteo, each behind a circuit breaker. A validated
//! StationKit observation within 50 km and 60 min overlays `current`. When
//! every provider fails this Worker answers `503`; it never invents data.
//! Callers that want the seasonal estimate (the app) add it themselves.
//!
//! `refresh=1` skips the cache read and stores the fresh answer. Only the
//! jobs Worker sends it (cache warming); the API Workers build their own
//! query strings, so outside callers cannot force provider calls.

mod air;
mod chain;
mod places;
mod stations;

use serde_json::json;
use weather_core::query::{ForecastQuery, PlaceQuery};
use weather_core::{forecast, geo, normalize};
use weather_edge::{error, json, query_pairs};
use worker::{event, Context, Env, Method, Request, Response, Result};

#[event(fetch)]
pub async fn fetch(req: Request, env: Env, ctx: Context) -> Result<Response> {
    if req.method() != Method::Get {
        return error(405, "method_not_allowed", "Only GET is served.");
    }
    match req.path().as_str() {
        "/weather" => weather(&req, &env, &ctx).await,
        "/daily" => daily(&req, &env, &ctx).await,
        "/air-quality" => air::air_quality(&req, &env, &ctx).await,
        "/health" => health(&env).await,
        _ => error(404, "not_found", "No such route."),
    }
}

async fn health(env: &Env) -> Result<Response> {
    let tomorrow = weather_edge::secret(env, weather_core::secrets::TOMORROW_API_KEY)
        .await
        .is_some();
    let nyuchi_api = places::nyuchi_api(env).await.is_some();
    json(
        200,
        &json!({
            "service": "mukoko-weather-forecast",
            "status": "ok",
            "configured": {
                "cache": env.kv(chain::CACHE_BINDING).is_ok(),
                "stations_db": env.d1(stations::DB_BINDING).is_ok(),
                "tomorrow": tomorrow,
                "nyuchi_api": nyuchi_api,
            }
        }),
    )
}

async fn weather(req: &Request, env: &Env, ctx: &Context) -> Result<Response> {
    let pairs = query_pairs(req)?;
    let get = |k: &str| pairs.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    let num = |k: &str| get(k).and_then(|v| v.trim().parse::<f64>().ok());
    let (Some(lat), Some(lon)) = (num("lat"), num("lon")) else {
        return error(422, "invalid_request", "Give both `lat` and `lon`.");
    };
    if !geo::valid_coordinates(lat, lon) {
        return error(422, "invalid_request", "Invalid coordinates.");
    }

    let refresh = get("refresh") == Some("1");
    let Some(mut got) = chain::forecast(env, ctx, lat, lon, refresh).await else {
        return error(
            503,
            "providers_unavailable",
            "No forecast provider answered.",
        );
    };
    let current_source = stations::overlay(env, &mut got.data, lat, lon).await;

    if get("extras") == Some("1") {
        let requested: Vec<&str> = get("models")
            .map(|m| m.split(',').filter(|s| !s.trim().is_empty()).collect())
            .unwrap_or_default();
        let models = normalize::sanitize_models(&requested);
        if let Some(extras) = chain::extras(lat, lon, &models).await {
            if let (Some(d), Some(x)) = (got.data.as_object_mut(), extras.as_object()) {
                for (k, v) in x {
                    d.insert(k.clone(), v.clone());
                }
            }
        }
    }

    let resp = json(200, &got.data)?;
    let h = resp.headers();
    h.set("X-Cache", if got.cache_hit { "HIT" } else { "MISS" })?;
    h.set("X-Weather-Provider", got.source.as_str())?;
    h.set(
        "X-Current-Source",
        current_source.unwrap_or(got.source).as_str(),
    )?;
    h.set("X-Fetched-At", &got.fetched_at)?;
    Ok(resp)
}

async fn daily(req: &Request, env: &Env, ctx: &Context) -> Result<Response> {
    let pairs = query_pairs(req)?;
    let query = match ForecastQuery::parse(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str()))) {
        Ok(q) => q,
        Err(e) => return error(422, "invalid_request", &e.to_string()),
    };
    let place = match &query.place {
        PlaceQuery::Point { lat, lon } => weather_core::places::place_for_point(*lat, *lon),
        PlaceQuery::Named(name) => match places::resolve(env, name).await {
            places::Resolved::Found(p) => p,
            places::Resolved::Unknown => {
                return error(404, "unknown_location", "Unknown location.")
            }
            places::Resolved::Unavailable => {
                return error(
                    503,
                    "places_unavailable",
                    "The place directory did not answer.",
                )
            }
        },
    };
    let Some(got) = chain::forecast(env, ctx, place.lat, place.lon, false).await else {
        return error(
            503,
            "providers_unavailable",
            "No forecast provider answered.",
        );
    };
    let body = forecast::build_response(
        &place,
        &got.data,
        got.source,
        &got.fetched_at,
        usize::from(query.days),
    );
    let resp = json(200, &body)?;
    resp.headers()
        .set("X-Cache", if got.cache_hit { "HIT" } else { "MISS" })?;
    Ok(resp)
}
