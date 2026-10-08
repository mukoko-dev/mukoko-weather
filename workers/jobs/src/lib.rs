//! `mukoko-weather-jobs`: the scheduled work of the weather backend.
//!
//! No route and no workers.dev address. Three Cron Triggers plan the work
//! (`weather_core::jobs`) and put it on the `weather-jobs` queue; the queue
//! consumer, in this same Worker, does it one message at a time:
//!
//! - **warm** (`*/15 * * * *`): refresh the forecast cache for the popular
//!   places (`WARM_PLACES`), through the `FORECAST` service binding with
//!   `refresh=1`. Budget: places x 96 provider calls a day (576 for the six
//!   default places).
//! - **history** (`30 21 * * *`, 23:30 in Harare): one `place_daily` row per
//!   seed place, from the forecast Worker's `WeatherData` (never the seasonal
//!   estimate, which the forecast Worker does not serve).
//! - **maintenance** (`15 2 * * *`): roll yesterday's validated observations
//!   up into `station_daily`; archive D1 observations older than
//!   `RETENTION_DAYS` to R2 and delete them; delete raw uploads older than
//!   `RAW_RETENTION_DAYS`; drop day-old rate-limit events.
//!
//! Nothing here logs coordinates, payloads or keys: only job kinds and
//! counts.

mod tasks;

use weather_core::jobs::{plan, Job, Settings, Tick};
use weather_edge::config;
use worker::{
    console_error, console_log, event, Context, Env, MessageBatch, MessageExt, ScheduleContext,
    ScheduledEvent,
};

pub(crate) const DB: &str = "WEATHER_DB";
pub(crate) const RAW_BUCKET: &str = "RAW_OBSERVATIONS";
pub(crate) const FORECAST: &str = "FORECAST";
pub(crate) const QUEUE: &str = "JOBS";
/// Workers Queues accept at most 100 messages in one `sendBatch`.
const SEND_BATCH_MAX: usize = 100;

fn settings(env: &Env) -> Settings {
    Settings {
        warm_places: config(env, "WARM_PLACES"),
        retention_days: config(env, "RETENTION_DAYS"),
        raw_retention_days: config(env, "RAW_RETENTION_DAYS"),
    }
}

#[event(scheduled)]
pub async fn scheduled(event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    let cron = event.cron();
    let Some(tick) = Tick::from_cron(&cron) else {
        console_error!("jobs: no plan for cron {cron}");
        return;
    };
    let now = chrono::DateTime::from_timestamp_millis(event.schedule() as i64)
        .unwrap_or_else(weather_edge::now);
    let jobs = plan(tick, now, &settings(&env));
    let count = jobs.len();
    match enqueue(&env, jobs).await {
        Ok(()) => console_log!("jobs: {tick:?} queued {count}"),
        Err(e) => console_error!("jobs: {tick:?} enqueue failed: {e}"),
    }
}

pub(crate) async fn enqueue(env: &Env, jobs: Vec<Job>) -> worker::Result<()> {
    let queue = env.queue(QUEUE)?;
    for chunk in jobs.chunks(SEND_BATCH_MAX) {
        queue.send_batch(chunk.to_vec()).await?;
    }
    Ok(())
}

#[event(queue)]
pub async fn queue(batch: MessageBatch<Job>, env: Env, _ctx: Context) -> worker::Result<()> {
    for message in batch.messages()? {
        let job = message.body();
        match tasks::run(&env, job).await {
            Ok(()) => message.ack(),
            Err(e) => {
                console_error!("jobs: {} failed: {e}", tasks::kind(job));
                message.retry();
            }
        }
    }
    Ok(())
}
