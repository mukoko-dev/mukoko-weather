//! `mukoko-weather-forecast`: provider aggregation.
//!
//! The only Worker that talks to forecast providers. It has no route and no
//! workers.dev address: the API Workers reach it through service bindings.
//!
//! ```text
//! GET /weather?lat=&lon=[&models=a,b][&extras=1][&refresh=1][&priority=1]   full WeatherData (the app's shape)
//! GET /daily?location=|lat=&lon=[&days=1..7]       the daily forecast contract
//! GET /air-quality?lat=&lon=                       the EPA AQI (Open-Meteo air quality)
//! GET /air-quality/grid?lat=&lon=[&radiusKm=][&n=] US AQI on an n x n grid (one batched call)
//! GET /haze?lat=&lon=                              haze level, type, advice and season (Open-Meteo, NEA in Singapore)
//! GET /normals?lat=&lon=[&date=]                   1991-2020 average daily high and low (ERA5 via Open-Meteo)
//! GET /monthly-normals?lat=&lon=                   the twelve monthly normals: temperature, rainfall, rainy days
//! GET /enso                                        El Nino / La Nina phase (NOAA CPC ONI)
//! GET /sg-air[?lat=&lon=]                          official Singapore NEA PSI and PM2.5
//! GET /model-grid?lat=&lon=[&model=]               one model's 3-hourly forecast on a 7×7 grid
//! GET /health                                      which bindings are configured
//! ```
//!
//! Provider chain (ported from `api/py/_weather.py`, issue #246): KV cache
//! (`wx:v2:`, 15 min), then the Open-Meteo Africa-weighted blend of six global
//! models (served only when at least FOUR members return data), then Open-Meteo
//! `best_match`, marked as not a blend. Tomorrow.io is ENRICHMENT ONLY: it adds
//! a few insights fields behind a D1 budget (12 an hour and 250 a day for
//! normal traffic) and never provides the baseline. A validated StationKit
//! observation within 50 km and 60 min overlays `current`. When every provider
//! fails this Worker answers `503`; it never invents data. Callers that want
//! the seasonal estimate (the app) add it themselves.
//!
//! Response headers of `/weather`: `X-Cache`, `X-Weather-Provider`
//! (`open-meteo:blend` | `open-meteo:best_match`), `X-Weather-Blend` (region
//! and weights, a blend only), `X-Enrichment` (`tomorrow` | `skipped-budget` |
//! `skipped-error` | `none`), `X-Current-Source`, `X-Fetched-At`. The payload
//! carries `baseline` (`blend: true|false`, and why it is not a blend).
//!
//! `refresh=1` skips the cache read and stores the fresh answer. Only the
//! jobs Worker sends it (cache warming); the API Workers build their own
//! query strings, so outside callers cannot force provider calls.

mod air;
mod aq_grid;
mod chain;
mod enrich;
mod enso;
mod haze;
mod limit;
mod model_grid;
mod normals;
mod places;
mod sg_air;
mod stations;

use serde_json::{json, Value};
use weather_core::query::{ForecastQuery, PlaceQuery};
use weather_core::{blend, forecast, geo, normalize};
use weather_edge::{error, json, now, query_pairs};
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
        "/air-quality/grid" => aq_grid::air_quality_grid(&req, &env, &ctx).await,
        "/enso" => enso::enso(&env, &ctx).await,
        "/haze" => haze::haze(&req, &env, &ctx).await,
        "/normals" => normals::normals(&req, &env, &ctx).await,
        "/monthly-normals" => normals::monthly(&req, &env, &ctx).await,
        "/sg-air" => sg_air::sg_air(&req, &env, &ctx).await,
        "/model-grid" => model_grid::model_grid(&req, &env, &ctx).await,
        "/health" => health(&req, &env).await,
        _ => error(404, "not_found", "No such route."),
    }
}

async fn health(req: &Request, env: &Env) -> Result<Response> {
    let tomorrow = weather_edge::secret(env, weather_core::secrets::TOMORROW_API_KEY)
        .await
        .is_some();
    let nyuchi_api = places::nyuchi_api(env).await.is_some();
    let mongo = weather_edge::mongo(env).await;
    // `?probe=mongo` really connects and logs in (the first live check after
    // the connection string is set); the error names the problem, never the
    // string.
    let probe = if query_pairs(req)?
        .iter()
        .any(|(k, v)| k == "probe" && v == "mongo")
    {
        Some(match &mongo {
            None => json!({"ok": false, "error": "not configured"}),
            Some(m) => match m.ping("admin").await {
                Ok(()) => json!({"ok": true}),
                Err(e) => json!({"ok": false, "error": e.to_string()}),
            },
        })
    } else {
        None
    };
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
                "mongo": mongo.is_some(),
            },
            "mongo_probe": probe,
            // Tomorrow.io is enrichment only; its caps and use, no live call.
            "enrichment": enrich::snapshot(env).await,
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
    // Set only by trusted internal callers (this Worker has no public route).
    let priority = get("priority") == Some("1");

    // Tomorrow.io enriches the insights; it never touches the baseline.
    let enrichment = enrich::apply(env, ctx, &mut got.data, lat, lon, priority).await;
    let station = stations::overlay(env, &mut got.data, lat, lon).await;

    if get("extras") == Some("1") {
        let requested: Vec<&str> = get("models")
            .map(|m| m.split(',').filter(|s| !s.trim().is_empty()).collect())
            .unwrap_or_default();
        attach_comparison(&mut got.data, lat, lon, &requested).await;
    }

    // The offset must ALWAYS be present, and the nowcast must not start in
    // the past (a cached row may be minutes old).
    blend::ensure_utc_offset(&mut got.data, lon);
    if let Some(m) = got.data.get("minutely").filter(|m| !m.is_null()).cloned() {
        let offset = got.data["utc_offset_seconds"].as_i64().unwrap_or(0);
        got.data["minutely"] = blend::fresh_minutely(&m, offset, now());
    }

    let resp = json(200, &got.data)?;
    let h = resp.headers();
    h.set("X-Cache", if got.cache_hit { "HIT" } else { "MISS" })?;
    h.set("X-Weather-Provider", &got.provider)?;
    if let Some(b) = &got.blend {
        h.set("X-Weather-Blend", b)?;
    }
    h.set("X-Enrichment", enrichment.as_str())?;
    h.set(
        "X-Current-Source",
        match station {
            Some(s) => s.as_str(),
            None => got.provider.as_str(),
        },
    )?;
    h.set("X-Fetched-At", &got.fetched_at)?;
    Ok(resp)
}

/// Make sure every requested comparison model has a series (port of
/// `_attach_comparison`). The blend already carries its members' series; only
/// when the caller asks for a model that is not there is the extras call made,
/// best effort, breaker gated, never failing the response.
async fn attach_comparison(data: &mut Value, lat: f64, lon: f64, requested: &[&str]) {
    let wanted: Option<Vec<String>> =
        (!requested.is_empty()).then(|| normalize::sanitize_models(requested));
    let have: Vec<String> = data["models_available"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let has_series = data["models"].as_array().is_some_and(|m| !m.is_empty());
    if has_series
        && wanted
            .as_ref()
            .is_none_or(|w| w.iter().all(|m| have.contains(m)))
    {
        if let Some(w) = &wanted {
            if let Some(series) = data["models"].as_array().cloned() {
                data["models"] = Value::Array(
                    series
                        .into_iter()
                        .filter(|s| {
                            s["model"]
                                .as_str()
                                .is_some_and(|m| w.iter().any(|x| x == m))
                        })
                        .collect(),
                );
            }
            data["models_available"] = json!(have
                .into_iter()
                .filter(|m| w.contains(m))
                .collect::<Vec<_>>());
        }
        return;
    }
    let models = normalize::sanitize_models(requested);
    let Some(extras) = chain::extras(lat, lon, &models).await else {
        return;
    };
    if data["minutely"].is_null() {
        data["minutely"] = extras["minutely"].clone();
    }
    for k in ["models", "models_available", "models_time"] {
        data[k] = extras[k].clone();
    }
    // The extras call resolves the offset, zone and elevation for the point
    // when the baseline lacked them.
    for k in ["utc_offset_seconds", "timezone", "elevation"] {
        if data.get(k).is_none_or(Value::is_null) && !extras[k].is_null() {
            data[k] = extras[k].clone();
        }
    }
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
