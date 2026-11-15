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
//! - **alerts** (`10 * * * *`, hourly): device push for frost (#289, #579). One
//!   `Job::Alerts` per `PUSH_PLACES` place (default `WARM_PLACES`): read the
//!   forecast, ask the Nyuchi API who follows the place, CLAIM each alert in the
//!   delivery log, push through the `PUSH` service binding only after the claim
//!   is won, log the outcome, deactivate subscriptions that are gone
//!   (`alerts.rs`). **Does nothing unless `ALERTS_ENABLED` is exactly `true`**:
//!   with it off the tick logs one line and queues nothing.
//!
//! Nothing here logs coordinates, payloads, people, endpoints or keys: only job
//! kinds, outcomes and counts.

mod alerts;
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

pub(crate) fn settings(env: &Env) -> Settings {
    Settings {
        warm_places: config(env, "WARM_PLACES"),
        retention_days: config(env, "RETENTION_DAYS"),
        raw_retention_days: config(env, "RAW_RETENTION_DAYS"),
        push_places: config(env, "PUSH_PLACES"),
        alerts_enabled: config(env, "ALERTS_ENABLED"),
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
    let settings = settings(&env);
    // The switch for device push. `plan` returns nothing for the alert tick
    // while it is off; this says so, once, so a silent tick is not a mystery.
    if tick == Tick::Alerts && !settings.alerts_enabled() {
        console_log!("jobs: Alerts switched off (ALERTS_ENABLED is not true), nothing queued");
        return;
    }
    let jobs = plan(tick, now, &settings);
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
