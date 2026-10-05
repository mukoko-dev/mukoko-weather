//! The four routes. Each validates its body, gathers the weather it needs,
//! builds the prompt (guardrails first) and calls the model once.

use chrono::Duration as Days;
use futures::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use weather_core::ai::guardrails::{system_prompt, Compiled};
use weather_core::ai::history::{aggregate, fingerprint, Record};
use weather_core::ai::prompts::{self, one_line, Season, SummaryLocation};
use weather_core::ai::{activities, conversation, Invalid, Turn, REFUSAL};
use weather_core::places::{place_for_point, resolve_seed, slugify};
use weather_core::{geo, Place};
use weather_edge::{error, json, now, now_rfc3339};
use worker::{Env, Response, Result};

use crate::gateway::{self, Call, ModelError};
use crate::{CACHE_BINDING, DB_BINDING, FORECAST_BINDING};

/// Summaries live 30 minutes; the fallback text only a minute, so one
/// failed call does not hide real summaries for long.
const SUMMARY_TTL: u64 = 1_800;
const SUMMARY_FALLBACK_TTL: u64 = 60;
const HISTORY_TTL: u64 = 3_600;
/// A cached summary is redone early when the temperature moves more than this.
const STALE_TEMP_DELTA: f64 = 5.0;
/// Most places whose weather a chat message pulls in.
const CHAT_PLACES: usize = 3;
const TROUBLE: &str = "Shamwari is having trouble right now. Please try again in a moment.";

pub struct Ctx<'a> {
    pub env: &'a Env,
    pub guardrails: Compiled,
}

fn invalid(i: Invalid) -> Result<Response> {
    error(i.status(), i.code(), i.description())
}

fn rate_limited() -> Result<Response> {
    let resp = error(
        429,
        "rate_limited",
        "Shamwari is busy right now. Please try again shortly.",
    )?;
    resp.headers().set("Retry-After", "60")?;
    Ok(resp)
}

fn ids(v: &Value) -> Vec<String> {
    let raw: Vec<String> = v
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    activities(&raw)
}

fn turns(v: &Value) -> Vec<Turn> {
    serde_json::from_value(v.clone()).unwrap_or_default()
}

/// The full `WeatherData` for a point, from the forecast Worker.
async fn weather(env: &Env, lat: f64, lon: f64) -> Option<Value> {
    let fetcher = env.service(FORECAST_BINDING).ok()?;
    let mut resp = fetcher
        .fetch(
            format!("https://forecast/weather?lat={lat}&lon={lon}"),
            None,
        )
        .await
        .ok()?;
    if resp.status_code() != 200 {
        return None;
    }
    resp.json::<Value>().await.ok()
}

async fn kv_get<T: for<'de> Deserialize<'de>>(env: &Env, key: &str) -> Option<T> {
    let kv = env.kv(CACHE_BINDING).ok()?;
    kv.get(key).json::<T>().await.ok().flatten()
}

async fn kv_put<T: Serialize>(env: &Env, key: &str, value: &T, ttl: u64) {
    if let Ok(kv) = env.kv(CACHE_BINDING) {
        if let Ok(put) = kv.put(key, value) {
            let _ = put.expiration_ttl(ttl).execute().await;
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedSummary {
    insight: String,
    temperature: Option<f64>,
    weather_code: Option<i64>,
    generated_at: String,
}

/// `POST /v1/ai/summary`. The weather is fetched here; the client's
/// `weatherData` is not trusted into the prompt.
pub async fn summary(ctx: &Ctx<'_>, body: Value) -> Result<Response> {
    let loc = &body["location"];
    let (Some(lat), Some(lon)) = (loc["lat"].as_f64(), loc["lon"].as_f64()) else {
        return error(
            422,
            "invalid_request",
            "`location.lat` and `location.lon` are required.",
        );
    };
    if !geo::valid_coordinates(lat, lon) {
        return error(400, "invalid_request", "Invalid coordinates");
    }
    let place = place_for_point(lat, lon);
    let acts = ids(&body["activities"]);
    let name = loc["name"]
        .as_str()
        .map(|n| one_line(n, 100))
        .filter(|n| !n.is_empty())
        .or_else(|| place.name.clone())
        .unwrap_or_else(|| "this location".to_owned());

    let Some(data) = weather(ctx.env, lat, lon).await else {
        return error(
            503,
            "forecast_unavailable",
            "No forecast is available for this place right now.",
        );
    };
    let temp = data["current"]["temperature_2m"].as_f64();
    let code = data["current"]["weather_code"].as_i64();

    let key = format!("summary:v1:{}:{}", place.slug, acts.join(","));
    if let Some(c) = kv_get::<CachedSummary>(ctx.env, &key).await {
        let moved = match (c.temperature, temp) {
            (Some(a), Some(b)) => (a - b).abs() > STALE_TEMP_DELTA,
            _ => false,
        };
        if !moved && c.weather_code == code {
            return json(
                200,
                &json!({"insight": c.insight, "cached": true, "generatedAt": c.generated_at}),
            );
        }
    }

    let season = prompts::season(lat, now());
    let summary_loc = SummaryLocation {
        name: name.clone(),
        country: loc["country"]
            .as_str()
            .map(|c| one_line(c, 60))
            .or_else(|| place.country.clone()),
        lat,
        lon,
        elevation: loc["elevation"]
            .as_f64()
            .or(place.elevation)
            .or_else(|| data["elevation"].as_f64())
            .unwrap_or(0.0),
    };
    let request = prompts::summary_request(&summary_loc, &data, &acts, &season);
    let system = system_prompt(&ctx.guardrails, prompts::SUMMARY);
    let call = Call {
        route: "summary",
        max_tokens: prompts::SUMMARY_MAX_TOKENS,
    };
    let user = [Turn {
        role: "user".into(),
        content: request,
    }];
    let (insight, ttl) = match gateway::run(ctx.env, call, &system, &user).await {
        Ok(text) => (text, SUMMARY_TTL),
        Err(ModelError::RateLimited) => return rate_limited(),
        // A blocked or failed summary shows the plain conditions instead.
        Err(_) => (
            prompts::fallback_insight(&name, &data, &season),
            SUMMARY_FALLBACK_TTL,
        ),
    };
    let generated_at = now_rfc3339();
    kv_put(
        ctx.env,
        &key,
        &CachedSummary {
            insight: insight.clone(),
            temperature: temp,
            weather_code: code,
            generated_at: generated_at.clone(),
        },
        ttl,
    )
    .await;
    json(
        200,
        &json!({"insight": insight, "cached": false, "generatedAt": generated_at}),
    )
}

/// `POST /v1/ai/followup`.
pub async fn followup(ctx: &Ctx<'_>, body: Value) -> Result<Response> {
    let message = body["message"].as_str().unwrap_or("");
    let turns = match conversation(message, &turns(&body["history"])) {
        Ok(t) => t,
        Err(e) => return invalid(e),
    };
    let str_of = |k: &str| body[k].as_str().unwrap_or("");
    let app = prompts::followup_prompt(
        str_of("locationName"),
        str_of("locationSlug"),
        str_of("weatherSummary"),
        &ids(&body["activities"]),
        str_of("season"),
    );
    let system = system_prompt(&ctx.guardrails, &app);
    let call = Call {
        route: "followup",
        max_tokens: prompts::FOLLOWUP_MAX_TOKENS,
    };
    match gateway::run(ctx.env, call, &system, &turns).await {
        Ok(text) => json(200, &json!({"response": text})),
        Err(ModelError::Blocked) => json(200, &json!({"response": REFUSAL})),
        Err(ModelError::RateLimited) => rate_limited(),
        Err(ModelError::Failed) => json(200, &json!({"response": TROUBLE, "error": true})),
    }
}

/// `POST /v1/ai/chat`. The weather for the places the user names is fetched
/// first and put in the prompt, in place of the Python backend's tool loop.
pub async fn chat(ctx: &Ctx<'_>, body: Value) -> Result<Response> {
    let message = body["message"].as_str().unwrap_or("");
    let history = turns(&body["history"]);
    let turns = match conversation(message, &history) {
        Ok(t) => t,
        Err(e) => return invalid(e),
    };

    // Places in the new message; for a follow-up like "and tomorrow?", the
    // places of the conversation so far, newest first.
    let mut places = prompts::places_mentioned(message, CHAT_PLACES);
    if places.is_empty() {
        for t in turns.iter().rev().skip(1) {
            places = prompts::places_mentioned(&t.content, CHAT_PLACES);
            if !places.is_empty() {
                break;
            }
        }
    }
    let fetched = join_all(places.iter().map(|p| weather(ctx.env, p.lat, p.lon))).await;
    let facts: Vec<String> = places
        .iter()
        .zip(&fetched)
        .filter_map(|(p, d)| d.as_ref().map(|d| prompts::weather_facts(p, d)))
        .collect();
    let references: Vec<Value> = places
        .iter()
        .map(|p| json!({"slug": p.slug, "name": p.name.as_deref().unwrap_or(&p.slug), "type": "location"}))
        .collect();

    let app = prompts::chat_prompt(&ids(&body["activities"]), &facts);
    let system = system_prompt(&ctx.guardrails, &app);
    let call = Call {
        route: "chat",
        max_tokens: prompts::CHAT_MAX_TOKENS,
    };
    match gateway::run(ctx.env, call, &system, &turns).await {
        Ok(text) => json(200, &json!({"response": text, "references": references})),
        Err(ModelError::Blocked) => json(200, &json!({"response": REFUSAL, "references": []})),
        Err(ModelError::RateLimited) => rate_limited(),
        Err(ModelError::Failed) => json(
            200,
            &json!({"response": TROUBLE, "references": [], "error": true}),
        ),
    }
}

#[derive(Deserialize)]
struct DailyRow {
    date: String,
    current: Option<String>,
    daily: Option<String>,
    insights: Option<String>,
}

fn parsed(s: &Option<String>) -> Value {
    s.as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(Value::Null)
}

#[derive(Serialize, Deserialize)]
struct CachedAnalysis {
    analysis: String,
    stats: String,
}

enum Located {
    Found(Place),
    Unknown,
    Unavailable,
}

/// A slug to a place: the seed list, else the forecast Worker (which asks
/// the Nyuchi API).
async fn locate(env: &Env, slug: &str) -> Located {
    if let Some(p) = resolve_seed(slug) {
        return Located::Found(p.clone());
    }
    let Ok(fetcher) = env.service(FORECAST_BINDING) else {
        return Located::Unavailable;
    };
    let Ok(mut resp) = fetcher
        .fetch(
            format!("https://forecast/daily?location={slug}&days=1"),
            None,
        )
        .await
    else {
        return Located::Unavailable;
    };
    match resp.status_code() {
        200 => match resp.json::<Value>().await {
            Ok(b) => match serde_json::from_value::<Place>(b["location"].clone()) {
                Ok(p) => Located::Found(p),
                Err(_) => Located::Unavailable,
            },
            Err(_) => Located::Unavailable,
        },
        404 => Located::Unknown,
        _ => Located::Unavailable,
    }
}

/// `POST /v1/ai/history/analyze`, over the D1 `place_daily` rows.
pub async fn history(ctx: &Ctx<'_>, body: Value) -> Result<Response> {
    let slug = slugify(body["location"].as_str().unwrap_or(""));
    if slug.is_empty() {
        return error(400, "invalid_request", "Missing location");
    }
    let days = body["days"].as_u64().unwrap_or(30);
    if !(7..=365).contains(&days) {
        return error(422, "invalid_request", "`days` must be between 7 and 365.");
    }
    let place = match locate(ctx.env, &slug).await {
        Located::Found(p) => p,
        Located::Unknown => return error(404, "unknown_location", "Unknown location"),
        Located::Unavailable => {
            return error(503, "places_unavailable", "Location service unavailable")
        }
    };

    let since = (now() - Days::days(days as i64))
        .format("%Y-%m-%d")
        .to_string();
    let rows: Option<Vec<DailyRow>> = async {
        let db = ctx.env.d1(DB_BINDING).ok()?;
        db.prepare(
            "SELECT date, current, daily, insights FROM place_daily \
             WHERE slug = ?1 AND date >= ?2 ORDER BY date ASC",
        )
        .bind(&[place.slug.as_str().into(), since.as_str().into()])
        .ok()?
        .all()
        .await
        .ok()?
        .results()
        .ok()
    }
    .await;
    // No table yet (jobs not deployed) reads the same as no rows.
    let records: Vec<Record> = rows
        .unwrap_or_default()
        .into_iter()
        .map(|r| Record {
            current: parsed(&r.current),
            daily: parsed(&r.daily),
            insights: parsed(&r.insights),
            date: r.date,
        })
        .collect();
    if records.is_empty() {
        return error(
            404,
            "no_history",
            "No history data available for this period",
        );
    }
    let points = records.len();

    let acts = ids(&body["activities"]);
    let key = format!(
        "history:v1:{}:{days}:{}:{}",
        place.slug,
        fingerprint(&records),
        acts.join(",")
    );
    if let Some(c) = kv_get::<CachedAnalysis>(ctx.env, &key).await {
        return json(
            200,
            &json!({"analysis": c.analysis, "stats": c.stats, "cached": true, "dataPoints": points}),
        );
    }

    let stats = aggregate(&records);
    let name = place.name.clone().unwrap_or_else(|| place.slug.clone());
    let season: Season = prompts::season(place.lat, now());
    let request = prompts::history_request(
        &name,
        place.elevation.unwrap_or(0.0),
        &season,
        &acts,
        &stats,
    );
    let system = system_prompt(
        &ctx.guardrails,
        &prompts::history_prompt(&name, days as u32),
    );
    let call = Call {
        route: "history",
        max_tokens: prompts::HISTORY_MAX_TOKENS,
    };
    let user = [Turn {
        role: "user".into(),
        content: request,
    }];
    match gateway::run(ctx.env, call, &system, &user).await {
        Ok(analysis) => {
            kv_put(
                ctx.env,
                &key,
                &CachedAnalysis {
                    analysis: analysis.clone(),
                    stats: stats.clone(),
                },
                HISTORY_TTL,
            )
            .await;
            json(
                200,
                &json!({"analysis": analysis, "stats": stats, "cached": false, "dataPoints": points}),
            )
        }
        Err(ModelError::Blocked) => json(
            200,
            &json!({"analysis": REFUSAL, "stats": stats, "cached": false, "dataPoints": points}),
        ),
        Err(ModelError::RateLimited) => rate_limited(),
        Err(ModelError::Failed) => json(
            200,
            &json!({
                "analysis": "AI analysis is temporarily unavailable. The statistical summary is available above.",
                "stats": stats,
                "cached": false,
                "error": true,
                "dataPoints": points,
            }),
        ),
    }
}
