//! What each queued job does.

use serde_json::Value;
use weather_core::jobs::{
    archive_key, day_bounds_ms, parse_date, place_daily_row, Job, ARCHIVE_ROWS_PER_MESSAGE,
};
use weather_core::places::resolve_seed;
use weather_core::Place;
use weather_edge::{now, now_ms};
use worker::{console_log, D1PreparedStatement, Env, Error, Response, Result};

use crate::{enqueue, DB, FORECAST, RAW_BUCKET};

/// D1 allows 100 bound parameters per statement.
const IDS_PER_DELETE: usize = 100;

/// A short name for a job, for logs (no slugs, no coordinates).
pub fn kind(job: &Job) -> &'static str {
    match job {
        Job::Warm { .. } => "warm",
        Job::PlaceHistory { .. } => "place_history",
        Job::StationRollup { .. } => "station_rollup",
        Job::Archive { .. } => "archive",
        Job::RawCleanup { .. } => "raw_cleanup",
        Job::RateEvents { .. } => "rate_events",
    }
}

pub async fn run(env: &Env, job: &Job) -> Result<()> {
    match job {
        Job::Warm { slugs } => warm(env, slugs).await,
        Job::PlaceHistory { slugs } => place_history(env, slugs).await,
        Job::StationRollup { date } => station_rollup(env, date).await,
        Job::Archive { cutoff_ms } => archive(env, *cutoff_ms).await,
        Job::RawCleanup { prefix } => raw_cleanup(env, prefix).await,
        Job::RateEvents { before_ms } => rate_events(env, *before_ms).await,
    }
}

fn places(slugs: &[String]) -> Vec<&'static Place> {
    slugs.iter().filter_map(|s| resolve_seed(s)).collect()
}

/// `GET` a path on the forecast Worker; `None` unless it answers `200`.
async fn ask_forecast(env: &Env, path_and_query: &str) -> Result<Option<Response>> {
    let fetcher = env.service(FORECAST)?;
    Ok(fetcher
        .fetch(format!("https://forecast{path_and_query}"), None)
        .await
        .ok()
        .filter(|r| r.status_code() == 200))
}

/// Refresh the cache for each place. Best effort: a failed place waits for
/// the next tick rather than retrying (the next tick is 15 minutes away).
async fn warm(env: &Env, slugs: &[String]) -> Result<()> {
    let places = places(slugs);
    let mut ok = 0;
    for p in &places {
        let q = format!("/weather?lat={}&lon={}&refresh=1", p.lat, p.lon);
        if ask_forecast(env, &q).await?.is_some() {
            ok += 1;
        }
    }
    console_log!("jobs: warmed {ok}/{}", places.len());
    Ok(())
}

/// Upsert today's `place_daily` row for each place. Retried only when no
/// place could be recorded, so one bad place does not repeat the rest.
async fn place_history(env: &Env, slugs: &[String]) -> Result<()> {
    let places = places(slugs);
    let db = env.d1(DB)?;
    let mut statements: Vec<D1PreparedStatement> = Vec::new();
    for p in &places {
        let q = format!("/weather?lat={}&lon={}", p.lat, p.lon);
        let Some(mut resp) = ask_forecast(env, &q).await? else {
            continue;
        };
        let source = resp
            .headers()
            .get("X-Weather-Provider")?
            .unwrap_or_else(|| "unknown".to_owned());
        if source == "fallback" {
            continue;
        }
        let Ok(data) = resp.json::<Value>().await else {
            continue;
        };
        let row = place_daily_row(&data, now());
        let current = row.current.to_string();
        let daily = row.daily.map(|d| d.to_string());
        let insights = row.insights.map(|i| i.to_string());
        statements.push(
            db.prepare(
                "INSERT OR REPLACE INTO place_daily \
                 (slug, date, recorded_at, source, current, daily, insights) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .bind(&[
                p.slug.as_str().into(),
                row.date.as_str().into(),
                (now_ms() as f64).into(),
                source.as_str().into(),
                current.as_str().into(),
                daily.as_deref().into(),
                insights.as_deref().into(),
            ])?,
        );
    }
    let recorded = statements.len();
    if recorded > 0 {
        db.batch(statements).await?;
    }
    console_log!("jobs: history recorded {recorded}/{}", places.len());
    if recorded == 0 && !places.is_empty() {
        return Err(Error::RustError("no place could be recorded".into()));
    }
    Ok(())
}

/// Roll one UTC day of validated observations up into `station_daily`.
///
/// `precip_sum` is the largest rainfall value reported that day: stations
/// send the past hour's rain (Wunderground `rainin`), a rain rate (Ecowitt)
/// or a gauge reading (manual), so adding readings up would overcount.
async fn station_rollup(env: &Env, date: &str) -> Result<()> {
    let Some(day) = parse_date(date) else {
        return Ok(());
    };
    let (start, end) = day_bounds_ms(day);
    let db = env.d1(DB)?;
    let result = db
        .prepare(
            "INSERT OR REPLACE INTO station_daily \
             (station_id, date, observations, temp_min, temp_max, temp_mean, humidity_mean, \
              precip_sum, wind_max, gust_max, pressure_mean) \
             SELECT station_id, ?1, COUNT(*), \
               MIN(json_extract(metrics, '$.airTemperatureCelsius')), \
               MAX(json_extract(metrics, '$.airTemperatureCelsius')), \
               AVG(json_extract(metrics, '$.airTemperatureCelsius')), \
               AVG(json_extract(metrics, '$.relativeHumidityPercent')), \
               MAX(json_extract(metrics, '$.precipitationMillimeters')), \
               MAX(json_extract(metrics, '$.windSpeedKph')), \
               MAX(json_extract(metrics, '$.windGustKph')), \
               AVG(json_extract(metrics, '$.atmosphericPressureMillibar')) \
             FROM observations \
             WHERE qc_status = 'validated' AND observed_at >= ?2 AND observed_at < ?3 \
             GROUP BY station_id",
        )
        .bind(&[date.into(), (start as f64).into(), (end as f64).into()])?
        .run()
        .await?;
    let rows = result.meta()?.and_then(|m| m.changes).unwrap_or(0);
    console_log!("jobs: station rollup wrote {rows}");
    Ok(())
}

/// Archive the oldest observations past the cutoff to R2, then delete them.
/// R2 first: a retry after a failed delete rewrites the same object (the key
/// depends only on the rows) and deletes again.
async fn archive(env: &Env, cutoff_ms: i64) -> Result<()> {
    let db = env.d1(DB)?;
    let rows: Vec<Value> = db
        .prepare(
            "SELECT id, station_id, lat, lon, observed_at, qc_status, source_type, metrics, \
             country_code FROM observations WHERE observed_at < ?1 \
             ORDER BY observed_at, id LIMIT ?2",
        )
        .bind(&[
            (cutoff_ms as f64).into(),
            f64::from(ARCHIVE_ROWS_PER_MESSAGE).into(),
        ])?
        .all()
        .await?
        .results()?;
    if rows.is_empty() {
        return Ok(());
    }

    let ids: Vec<String> = rows
        .iter()
        .filter_map(|r| r["id"].as_str().map(str::to_owned))
        .collect();
    let at = |r: &Value| r["observed_at"].as_f64().unwrap_or(0.0) as i64;
    let first = rows.first().map(at).unwrap_or(0);
    let last = rows.last().map(at).unwrap_or(0);
    let mut body = String::new();
    for r in &rows {
        body.push_str(&r.to_string());
        body.push('\n');
    }
    env.bucket(RAW_BUCKET)?
        .put(archive_key(first, last, &ids), body.into_bytes())
        .execute()
        .await?;

    let mut deletes = Vec::new();
    for chunk in ids.chunks(IDS_PER_DELETE) {
        let marks: Vec<String> = (1..=chunk.len()).map(|i| format!("?{i}")).collect();
        let binds: Vec<_> = chunk.iter().map(|id| id.as_str().into()).collect();
        deletes.push(
            db.prepare(format!(
                "DELETE FROM observations WHERE id IN ({})",
                marks.join(", ")
            ))
            .bind(&binds)?,
        );
    }
    db.batch(deletes).await?;
    console_log!("jobs: archived {}", ids.len());
    Ok(())
}

/// Delete up to 1,000 raw uploads under a day prefix; if more remain, queue
/// the same prefix again.
async fn raw_cleanup(env: &Env, prefix: &str) -> Result<()> {
    if !prefix.starts_with("raw/") {
        return Ok(());
    }
    let bucket = env.bucket(RAW_BUCKET)?;
    let listed = bucket.list().prefix(prefix).limit(1000).execute().await?;
    let keys: Vec<String> = listed.objects().iter().map(|o| o.key()).collect();
    if keys.is_empty() {
        return Ok(());
    }
    let n = keys.len();
    bucket.delete_multiple(keys).await?;
    console_log!("jobs: raw cleanup deleted {n}");
    if listed.truncated() {
        enqueue(
            env,
            vec![Job::RawCleanup {
                prefix: prefix.to_owned(),
            }],
        )
        .await?;
    }
    Ok(())
}

async fn rate_events(env: &Env, before_ms: i64) -> Result<()> {
    env.d1(DB)?
        .prepare("DELETE FROM rate_events WHERE at < ?1")
        .bind(&[(before_ms as f64).into()])?
        .run()
        .await?;
    Ok(())
}
