//! The wire between the alert evaluator tick and the Nyuchi API's alert
//! routes (`GET /v1/notifications/alerts/targets`, `POST .../deliveries`,
//! `POST .../subscriptions/deactivate`; mukoko-dev/mukoko-weather#289, step d).
//!
//! Pure: it reads the API's JSON into the planner's [`AlertTarget`]s and writes
//! the bodies the tick posts back. No I/O, no clock, no key. The endpoint and
//! the two keys of a browser are secrets (whoever holds them can push to it), so
//! [`RunSubscription`] has no `Debug` that prints them and nothing here copies
//! one into an error, a log line or a delivery body.

use std::collections::BTreeMap;
use std::fmt;

use serde_json::{json, Value};

/// People per page asked of the targets route (the API's own cap).
pub const TARGETS_PAGE_LIMIT: u32 = 100;
/// Pages read for one place in one tick. Bounds the tick's subrequests whatever
/// the API answers: 10 pages is 1,000 people, which is also
/// `alert_plan::MAX_TARGETS_PER_PLACE`-sized work for one plan (a place with more
/// followers than that is read again on the next tick, never skipped silently:
/// the log says so).
pub const MAX_TARGET_PAGES: usize = 10;

use crate::alert_delivery::Deactivation;
use crate::alert_plan::AlertTarget;
use crate::push::{AlertPrefs, KIND_FROST, MAX_PUSHES_PER_DAY, MAX_PUSHES_PER_KIND_PER_NIGHT};

/// One browser to push to, exactly as the targets route returns it. Secret.
#[derive(Clone, PartialEq, Eq)]
pub struct RunSubscription {
    /// The subscription id (SHA-256 of its endpoint, hex): what the log and
    /// the deactivation name, and the planner's target id.
    pub id: String,
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

impl fmt::Debug for RunSubscription {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RunSubscription")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

/// One person the API says wants this alert at this place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunPerson {
    pub person_id: String,
    pub quiet_start: Option<String>,
    pub quiet_end: Option<String>,
    pub subscriptions: Vec<RunSubscription>,
}

/// One page of the targets route.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TargetsPage {
    pub people: Vec<RunPerson>,
    pub next_cursor: Option<String>,
    /// People or browsers that did not read as the API documents. Counted,
    /// never listed.
    pub invalid: usize,
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// Read one page of `GET /v1/notifications/alerts/targets`. A person or a
/// browser that is missing a field is dropped and counted: the alert would
/// have nowhere safe to go.
pub fn parse_targets(body: &Value) -> TargetsPage {
    let mut page = TargetsPage {
        next_cursor: text(body, "next_cursor"),
        ..TargetsPage::default()
    };
    let Some(people) = body.get("targets").and_then(Value::as_array) else {
        page.invalid += 1;
        return page;
    };
    for person in people {
        let Some(person_id) = text(person, "person_id") else {
            page.invalid += 1;
            continue;
        };
        let mut subscriptions = Vec::new();
        for sub in person
            .get("subscriptions")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice)
        {
            let keys = sub.get("keys").unwrap_or(&Value::Null);
            match (
                text(sub, "id"),
                text(sub, "endpoint"),
                text(keys, "p256dh"),
                text(keys, "auth"),
            ) {
                (Some(id), Some(endpoint), Some(p256dh), Some(auth)) => {
                    subscriptions.push(RunSubscription {
                        id,
                        endpoint,
                        p256dh,
                        auth,
                    });
                }
                _ => page.invalid += 1,
            }
        }
        page.people.push(RunPerson {
            person_id,
            quiet_start: text(person, "quiet_start"),
            quiet_end: text(person, "quiet_end"),
            subscriptions,
        });
    }
    page
}

/// The most subrequests one alert job makes: a Worker invocation allows 1,000,
/// and this leaves room for the forecast read, the pages, the deactivations and
/// the platform's own.
pub const MAX_SUBREQUESTS_PER_RUN: usize = 900;
/// Subrequests one send costs when its claim is won: the claim, the push, the
/// outcome log.
pub const SUBREQUESTS_PER_SEND: usize = 3;

/// Counts a job's subrequests so a place with many followers stops cleanly
/// instead of the runtime cutting the job off mid-send (which would leave a
/// claimed row `queued`: a missed alert). What is not reached this tick is
/// planned again on the next one, with the same key.
#[derive(Debug, Default)]
pub struct Budget {
    used: usize,
}

impl Budget {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spend `n`; `false` (and nothing spent) when it would pass the cap.
    pub fn take(&mut self, n: usize) -> bool {
        if self.used + n > MAX_SUBREQUESTS_PER_RUN {
            return false;
        }
        self.used += n;
        true
    }

    /// Give back what a step reserved and did not use (a claim not won spends
    /// one subrequest, not three).
    pub fn refund(&mut self, n: usize) {
        self.used = self.used.saturating_sub(n);
    }

    pub fn used(&self) -> usize {
        self.used
    }
}

/// A forecast series, read out of the forecast Worker's `/weather` answer.
#[derive(Debug, Clone, PartialEq)]
pub struct ForecastSeries {
    /// Local wall-clock `YYYY-MM-DDTHH:MM`, as Open-Meteo writes them.
    pub times: Vec<String>,
    /// Air temperature (C); `NaN` where the provider had none (the frost
    /// evaluation skips a value that is not finite, so a gap never reads as
    /// cold).
    pub temps: Vec<f64>,
    pub utc_offset_seconds: i32,
}

/// The hourly temperatures and the place's UTC offset from a `/weather`
/// answer. `None` unless there is a series and an offset: the offset is what
/// turns `now` into the place's local hour, and a guessed one would put a
/// "tonight" alert on the wrong night, so a place with no offset gets no alert
/// this tick rather than an assumed one.
pub fn forecast_series(data: &Value) -> Option<ForecastSeries> {
    let times: Vec<String> = data
        .pointer("/hourly/time")?
        .as_array()?
        .iter()
        .map(|t| t.as_str().map(str::to_owned))
        .collect::<Option<_>>()?;
    let temps: Vec<f64> = data
        .pointer("/hourly/temperature_2m")?
        .as_array()?
        .iter()
        .map(|t| t.as_f64().unwrap_or(f64::NAN))
        .collect();
    if times.is_empty() || temps.is_empty() {
        return None;
    }
    let offset = data.get("utc_offset_seconds")?.as_f64()?;
    // -12 to +14 hours, whole seconds (the bound `PlaceInput` documents).
    if offset.fract() != 0.0 || !(-43_200.0..=50_400.0).contains(&offset) {
        return None;
    }
    Some(ForecastSeries {
        times,
        temps,
        utc_offset_seconds: offset as i32,
    })
}

fn is_cursor(c: &str) -> bool {
    (1..=64).contains(&c.len())
        && c.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The path and query of one page of the targets route. `None` for a place
/// slug or cursor outside what the API accepts (the place key grammar is the
/// API's; a slug with anything but `[a-z0-9-]` is never put in a URL here, and
/// a cursor must match the API's `^[A-Za-z0-9_-]{1,64}$`).
pub fn targets_path(place_slug: &str, cursor: Option<&str>) -> Option<String> {
    crate::push::validate_slug(place_slug).ok()?;
    let mut path = format!(
        "/v1/notifications/alerts/targets?place_slug={place_slug}&kind={KIND_FROST}&limit={TARGETS_PAGE_LIMIT}"
    );
    if let Some(c) = cursor {
        if !is_cursor(c) {
            return None;
        }
        path.push_str("&cursor=");
        path.push_str(c);
    }
    Some(path)
}

/// What one person has been sent in this run, so the per-person caps hold
/// across the places of one tick. (Across ticks the delivery log's claim is the
/// authority for the same alert; see `docs` in the README: the caps across
/// ticks need counts the API does not serve yet.)
#[derive(Debug, Default)]
pub struct RunCounts {
    sent: BTreeMap<String, u32>,
}

impl RunCounts {
    pub fn record(&mut self, person_id: &str) {
        *self.sent.entry(person_id.to_owned()).or_default() += 1;
    }

    fn sent(&self, person_id: &str) -> u32 {
        self.sent.get(person_id).copied().unwrap_or(0)
    }
}

/// The planner's targets for one place: one per browser, the id being the
/// subscription id. A person with no browser has no target (their inbox is
/// the record). A person whose preferences do not read is skipped and counted
/// in the second return value.
pub fn alert_targets(
    people: &[RunPerson],
    place_slug: &str,
    counts: &RunCounts,
) -> (Vec<AlertTarget>, usize) {
    let mut targets = Vec::new();
    let mut bad = 0usize;
    for person in people {
        let prefs = match AlertPrefs::from_api(
            &[KIND_FROST],
            person.quiet_start.as_deref(),
            person.quiet_end.as_deref(),
            &[place_slug.to_owned()],
        ) {
            Ok(prefs) => prefs,
            Err(_) => {
                bad += 1;
                continue;
            }
        };
        let sent = counts.sent(&person.person_id);
        for sub in &person.subscriptions {
            targets.push(AlertTarget {
                id: sub.id.clone(),
                prefs: prefs.clone(),
                active: true,
                already_sent_this_night: false,
                sent_today: sent.min(MAX_PUSHES_PER_DAY),
                sent_kind_tonight: sent.min(MAX_PUSHES_PER_KIND_PER_NIGHT),
            });
        }
    }
    (targets, bad)
}

/// The `POST /deliveries` body. No message text, endpoint or key can be in it.
pub struct Delivery<'a> {
    pub person_id: &'a str,
    pub dedupe_key: &'a str,
    pub place_slug: &'a str,
    pub subscription_id: &'a str,
    /// `queued` to claim, then `sent`, `gone` or `failed` on the same row.
    pub status: &'a str,
    pub provider_code: Option<u16>,
    pub ttl: u32,
    pub urgency: &'a str,
    pub topic: &'a str,
}

pub fn delivery_body(d: &Delivery) -> Value {
    let mut body = json!({
        "person_id": d.person_id,
        "dedupe_key": d.dedupe_key,
        "kind": KIND_FROST,
        "place_slug": d.place_slug,
        "channel": "web_push",
        "subscription_id": d.subscription_id,
        "status": d.status,
        "push_ttl": d.ttl,
        "push_urgency": d.urgency,
        "push_topic": d.topic,
    });
    if let (Some(code), Some(map)) = (d.provider_code, body.as_object_mut()) {
        map.insert("provider_code".into(), json!(code));
    }
    body
}

/// The `POST /subscriptions/deactivate` body for one call of a plan.
pub fn deactivate_body(call: &[Deactivation]) -> Value {
    json!({
        "subscriptions": call
            .iter()
            .map(|d| json!({"person_id": d.person_id, "id": d.subscription_id}))
            .collect::<Vec<_>>(),
        "reason": "gone",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page() -> Value {
        json!({
            "place_slug": "harare", "kind": "frost", "limit": 100, "next_cursor": "p2",
            "targets": [
                {"person_id": "p1", "quiet_start": "22:00", "quiet_end": "06:00",
                 "subscriptions": [{"id": "a1", "endpoint": "https://fcm.googleapis.com/x",
                                    "keys": {"p256dh": "K", "auth": "A"}}]},
                {"person_id": "p2", "subscriptions": []},
                {"quiet_start": "x"},
                {"person_id": "p3", "subscriptions": [{"id": "b", "endpoint": "https://e"}]}
            ]
        })
    }

    #[test]
    fn a_page_is_read_and_what_does_not_read_is_counted() {
        let p = parse_targets(&page());
        assert_eq!(p.next_cursor.as_deref(), Some("p2"));
        assert_eq!(p.people.len(), 3);
        assert_eq!(
            p.invalid, 2,
            "a person with no id and a browser with no keys"
        );
        assert_eq!(p.people[0].subscriptions[0].id, "a1");
        assert!(p.people[2].subscriptions.is_empty());
    }

    #[test]
    fn a_body_without_a_target_list_is_invalid_not_a_panic() {
        assert_eq!(parse_targets(&json!({})).invalid, 1);
        assert_eq!(parse_targets(&Value::Null).people.len(), 0);
    }

    #[test]
    fn debug_never_prints_an_endpoint_or_a_key() {
        let p = parse_targets(&page());
        let printed = format!("{:?}", p.people[0]);
        for secret in ["fcm.googleapis", "\"K\"", "\"A\""] {
            assert!(!printed.contains(secret), "{printed}");
        }
    }

    #[test]
    fn one_target_per_browser_and_none_for_a_person_with_no_browser() {
        let people = parse_targets(&page()).people;
        let (targets, bad) = alert_targets(&people, "harare", &RunCounts::default());
        assert_eq!((targets.len(), bad), (1, 0));
        assert_eq!(targets[0].id, "a1");
        assert!(targets[0].active && !targets[0].already_sent_this_night);
        assert_eq!(targets[0].prefs.places, ["harare"]);
        assert!(targets[0].prefs.frost);
    }

    #[test]
    fn bad_quiet_hours_skip_the_person_and_are_counted() {
        let mut people = parse_targets(&page()).people;
        people[0].quiet_start = Some("22:30".into());
        let (targets, bad) = alert_targets(&people, "harare", &RunCounts::default());
        assert!(targets.is_empty());
        assert_eq!(bad, 1, "only the person whose window does not read");
    }

    #[test]
    fn counts_carry_the_caps_across_places_of_one_run() {
        let people = parse_targets(&page()).people;
        let mut counts = RunCounts::default();
        counts.record("p1");
        let (targets, _) = alert_targets(&people, "bulawayo", &counts);
        assert_eq!(targets[0].sent_today, 1);
        assert_eq!(targets[0].sent_kind_tonight, MAX_PUSHES_PER_KIND_PER_NIGHT);
        counts.record("p1");
        counts.record("p1");
        let (targets, _) = alert_targets(&people, "bulawayo", &counts);
        assert_eq!(targets[0].sent_today, MAX_PUSHES_PER_DAY);
    }

    #[test]
    fn a_delivery_body_carries_no_endpoint_key_or_text() {
        let body = delivery_body(&Delivery {
            person_id: "p1",
            dedupe_key: "-17.85_31.05:frost:2026-11-14",
            place_slug: "harare",
            subscription_id: "a1",
            status: "sent",
            provider_code: Some(201),
            ttl: 3600,
            urgency: "normal",
            topic: "t",
        });
        let mut keys: Vec<&str> = body
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        let mut want = [
            "person_id",
            "dedupe_key",
            "kind",
            "place_slug",
            "channel",
            "subscription_id",
            "status",
            "push_ttl",
            "push_urgency",
            "push_topic",
            "provider_code",
        ];
        want.sort_unstable();
        assert_eq!(keys, want, "exactly these fields: no endpoint, key or text");
        assert_eq!(body["channel"], "web_push");
    }

    #[test]
    fn a_deactivation_names_the_person_and_the_subscription_and_only_gone() {
        let call = vec![Deactivation {
            person_id: "p1".into(),
            subscription_id: "a1".into(),
        }];
        assert_eq!(
            deactivate_body(&call),
            json!({"subscriptions": [{"person_id": "p1", "id": "a1"}], "reason": "gone"})
        );
    }

    fn weather(offset: Value) -> Value {
        json!({
            "hourly": {
                "time": ["2026-11-14T22:00", "2026-11-14T23:00", "2026-11-15T00:00"],
                "temperature_2m": [4.5, null, 1.0],
            },
            "utc_offset_seconds": offset,
        })
    }

    #[test]
    fn a_series_is_read_with_a_gap_that_is_not_cold() {
        let s = forecast_series(&weather(json!(7200))).expect("reads");
        assert_eq!(s.times.len(), 3);
        assert_eq!(s.utc_offset_seconds, 7200);
        assert_eq!(s.temps[0], 4.5);
        assert!(s.temps[1].is_nan(), "a missing value is not a number");
        assert_eq!(s.temps[2], 1.0);
    }

    #[test]
    fn a_series_without_an_offset_or_with_an_impossible_one_is_not_used() {
        for offset in [
            json!(null),
            json!("7200"),
            json!(7200.5),
            json!(60 * 3600),
            json!(-13 * 3600),
        ] {
            assert!(
                forecast_series(&weather(offset.clone())).is_none(),
                "{offset}"
            );
        }
        let mut no_offset = weather(json!(0));
        no_offset
            .as_object_mut()
            .expect("object")
            .remove("utc_offset_seconds");
        assert!(forecast_series(&no_offset).is_none());
        assert_eq!(
            forecast_series(&weather(json!(-43_200)))
                .expect("edge")
                .utc_offset_seconds,
            -43_200
        );
        assert_eq!(
            forecast_series(&weather(json!(50_400)))
                .expect("edge")
                .utc_offset_seconds,
            50_400
        );
    }

    #[test]
    fn a_series_that_is_not_a_series_is_not_used() {
        for body in [
            json!({}),
            json!({"hourly": {}, "utc_offset_seconds": 0}),
            json!({"hourly": {"time": [], "temperature_2m": []}, "utc_offset_seconds": 0}),
            json!({"hourly": {"time": [1, 2], "temperature_2m": [1.0, 2.0]}, "utc_offset_seconds": 0}),
            json!({"hourly": {"time": ["2026-11-14T22:00"]}, "utc_offset_seconds": 0}),
        ] {
            assert!(forecast_series(&body).is_none(), "{body}");
        }
    }

    #[test]
    fn the_targets_path_names_the_place_the_kind_and_the_page_size() {
        assert_eq!(
            targets_path("victoria-falls", None).as_deref(),
            Some("/v1/notifications/alerts/targets?place_slug=victoria-falls&kind=frost&limit=100")
        );
        assert_eq!(
            targets_path("harare", Some("a1_B-2")).as_deref(),
            Some("/v1/notifications/alerts/targets?place_slug=harare&kind=frost&limit=100&cursor=a1_B-2")
        );
    }

    #[test]
    fn nothing_but_a_slug_and_a_cursor_in_the_api_grammar_reaches_a_url() {
        for slug in [
            "",
            "Harare",
            "har are",
            "harare&kind=severe",
            "harare/../x",
            "ha?re",
        ] {
            assert!(targets_path(slug, None).is_none(), "{slug:?}");
        }
        for cursor in ["", "a b", "x&limit=1", "a/b", "é", &"c".repeat(65)] {
            assert!(targets_path("harare", Some(cursor)).is_none(), "{cursor:?}");
        }
        assert!(targets_path("harare", Some(&"c".repeat(64))).is_some());
    }

    #[test]
    fn a_page_cap_exists_and_is_small() {
        assert_eq!(MAX_TARGET_PAGES, 10);
        assert_eq!(TARGETS_PAGE_LIMIT, 100);
    }

    #[test]
    fn the_budget_stops_at_the_cap_and_a_refused_step_costs_nothing() {
        let mut b = Budget::new();
        assert!(b.take(MAX_SUBREQUESTS_PER_RUN - 2));
        assert!(!b.take(3), "would pass the cap");
        assert_eq!(
            b.used(),
            MAX_SUBREQUESTS_PER_RUN - 2,
            "a refusal spends nothing"
        );
        assert!(b.take(2));
        assert!(!b.take(1));
        b.refund(2);
        assert!(b.take(2), "a refund gives it back");
        b.refund(10 * MAX_SUBREQUESTS_PER_RUN);
        assert_eq!(b.used(), 0, "a refund never goes below zero");
    }

    #[test]
    fn a_full_run_of_sends_fits_in_a_workers_subrequests() {
        // The forecast, ten pages and a handful of deactivation calls, then
        // sends at three each: the sends that fit are well under the runtime's
        // 1,000.
        let overhead = 1 + MAX_TARGET_PAGES + 5;
        let sends = (MAX_SUBREQUESTS_PER_RUN - overhead) / SUBREQUESTS_PER_SEND;
        assert!(overhead + sends * SUBREQUESTS_PER_SEND < 1000);
        assert!(sends >= 200, "at least one plan's worth of sends: {sends}");
    }
}
