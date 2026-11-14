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
}
