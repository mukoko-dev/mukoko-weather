//! The delivery log's claim, and what a batch of push results may deactivate
//! (mukoko-dev/mukoko-weather#289, step d, the pure half).
//!
//! Two rules the evaluator tick needs and must not get wrong, with no network,
//! no clock and no key in either, so neither can send anything.
//!
//! **1. The claim ([`read_claim`]).** A [`crate::alert_plan::PlannedSend`] only
//! authorises an attempt to *claim* its dedupe key in the delivery log (the
//! Nyuchi API's `POST /v1/notifications/alerts/deliveries` with status
//! `queued`). The log is what stops a second push, so a send happens only after
//! the claim is won, and the contract the API publishes for that is exact:
//!
//! - `201` with result `created`: this call made the row. Send.
//! - `200` with result `updated` and status `queued`: a retryable failure,
//!   claimed again. Send.
//! - Anything else holds no claim. `200 unchanged` is a repeat, or another tick
//!   that won the claim first or already finished the alert. A `409` is a lost
//!   race the API asks to be retried. A `408`, `429`, a `5xx` or no answer at
//!   all is the API (or the path to it) being unavailable; the plan is made
//!   again on the next tick, with the same key. A `408` is treated as no
//!   answer: if the row was in fact created before the timeout, the next tick
//!   finds it `queued` and holds (see the known limit below). A `401`, `403`, `413` or `422` is our request refused,
//!   which retrying will not fix.
//!
//! The reader is strict on purpose: a `2xx` whose body is missing, unreadable
//! or says something else is *not* a won claim. Sending on a doubtful answer is
//! the one mistake that cannot be taken back (a second push to a person), while
//! not sending is repaired by the next tick.
//!
//! **2. What a batch may deactivate ([`plan_deactivations`]).** A push service
//! says `404` or `410` when a subscription is gone, and `403` when it was made
//! with another VAPID key ([`crate::push::classify_status`] calls all three
//! [`Outcome::Expired`]). A wrong or rotated sender key, a wrong audience for
//! one service, or a clock far off, makes a push service answer `403` to
//! *every* send it gets, which is an operator problem and not a thousand people
//! who left. So the guard looks at each push service on its own (the origin
//! each result carries): if a service was sent at least [`GUARD_MIN_BATCH`]
//! distinct subscriptions and refused every one as `Expired`, none of that
//! service's is deactivated and the count is reported. Another service
//! accepting does not turn the guard off for a service that refused everything.
//! Below the minimum, "all of them" says nothing, and a lone gone subscription
//! must still be switched off. (A mixed batch that a service answers partly
//! with `403` is believed: after a key rotation the old subscriptions get `403`
//! for ever while new ones work, and those really are lost.)
//!
//! What is deactivated is an explicit list and never "all": at most
//! [`MAX_DEACTIVATIONS_PER_CALL`] per call (the Nyuchi API's own limit), a
//! subscription named once however often it appears, ids that fail the opaque
//! id check dropped and counted, never echoed.
//!
//! **Known limit: at most once.** The log is the only thing that stops a second
//! push, and a `queued` row is not re-claimable: a retryable failure moves the
//! row to `failed`, which can be claimed again, but a sender that dies *between*
//! winning the claim and logging an outcome leaves the row `queued`. Every later
//! tick reads `200 unchanged` and holds, so that person misses that night's
//! alert. This is the trade the contract makes (a lost alert is repaired by
//! nothing; a duplicate push cannot be taken back), and it needs the Nyuchi API
//! to re-lease a `queued` row that has been held too long before it can be
//! closed. Tracked on #289; nothing here can fix it.
//!
//! The two bounds below are ours, untuned: no standard names them.

use std::collections::{BTreeMap, BTreeSet};

use crate::alert_plan::is_target_id;
use crate::push::Outcome;

/// The Nyuchi API's limit on one `POST /subscriptions/deactivate`.
pub const MAX_DEACTIVATIONS_PER_CALL: usize = 100;

/// The smallest batch the "every send was refused" guard applies to. Below it
/// a lone `Expired` result is believed.
pub const GUARD_MIN_BATCH: usize = 3;

/// What the Nyuchi API answered to a claim (`status: queued`): the HTTP status
/// (`0` for no answer at all) and the `result` and `status` fields of the body,
/// when it had them.
#[derive(Debug, Clone, Copy)]
pub struct ClaimAnswer<'a> {
    pub http_status: u16,
    pub result: Option<&'a str>,
    pub status: Option<&'a str>,
}

/// Whether the claim was won.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Claim {
    /// This call holds the alert: send it, then log the outcome on the same row.
    Won,
    /// The log already holds it (a repeat, another tick, or a finished alert),
    /// or the answer could not be read as a won claim. Do nothing.
    Held,
    /// A lost race, or the API is unavailable. Do nothing now; the next tick
    /// plans the same alert with the same key and tries again.
    Retry,
    /// Our request was refused. Retrying will not change it: count it and look.
    Refused,
}

impl Claim {
    /// Whether a push may be sent. Only [`Claim::Won`].
    pub fn may_send(self) -> bool {
        self == Claim::Won
    }

    /// A stable snake_case code for logs and counters.
    pub fn code(self) -> &'static str {
        match self {
            Claim::Won => "won",
            Claim::Held => "held",
            Claim::Retry => "retry",
            Claim::Refused => "refused",
        }
    }
}

/// Read the API's answer to a claim. Fails closed: only the two exact shapes
/// in the module docs are [`Claim::Won`].
pub fn read_claim(a: &ClaimAnswer) -> Claim {
    match (a.http_status, a.result, a.status) {
        (201, Some("created"), Some("queued")) | (200, Some("updated"), Some("queued")) => {
            Claim::Won
        }
        // A 2xx that is not a won claim: a repeat, a finished alert, or a body
        // that is missing, unreadable or says something else.
        (200..=299, _, _) => Claim::Held,
        // A lost race the API asks to be tried again, no answer, a timeout, a
        // rate limit or a server fault.
        (0 | 408 | 409 | 429 | 500..=599, _, _) => Claim::Retry,
        // 401, 403, 413, 422 and everything else.
        _ => Claim::Refused,
    }
}

/// One send's result, for one subscription of one person.
#[derive(Debug, Clone, Copy)]
pub struct SendResult<'a> {
    pub person_id: &'a str,
    pub subscription_id: &'a str,
    /// The push service it was sent to (`push::endpoint_origin` of the
    /// subscription's endpoint, an allow-listed host). Only used to group the
    /// batch for the guard; never copied into a plan.
    pub origin: &'a str,
    pub outcome: Outcome,
}

/// One subscription to switch off: the pair the API needs (the person and the
/// subscription id must both match).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Deactivation {
    pub person_id: String,
    pub subscription_id: String,
}

/// What to send to `POST /subscriptions/deactivate`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DeactivationPlan {
    /// Calls to make, each at most [`MAX_DEACTIVATIONS_PER_CALL`] long, in
    /// (person, subscription) order. Empty when nothing may be deactivated.
    pub calls: Vec<Vec<Deactivation>>,
    /// Distinct subscriptions the push service said were gone but that are NOT
    /// in `calls` because every send of the batch came back `Expired`: a sign
    /// of a wrong key or clock, to be reported to an operator.
    pub held_back: usize,
    /// Results whose ids failed the opaque id check, counted and never copied.
    pub invalid: usize,
}

impl DeactivationPlan {
    /// Subscriptions that will be switched off.
    pub fn total(&self) -> usize {
        self.calls.iter().map(Vec::len).sum()
    }
}

/// Decide which subscriptions a batch of push results switches off.
///
/// Only [`Outcome::Expired`] results are candidates; `Retry` and `Failed` never
/// switch anything off. Per push service (the `origin` of each result): if it
/// was sent at least [`GUARD_MIN_BATCH`] distinct subscriptions and refused
/// every one as `Expired`, none of its subscriptions is deactivated and the
/// distinct candidates are counted in [`DeactivationPlan::held_back`]. The
/// answer does not depend on the order of `results`.
pub fn plan_deactivations(results: &[SendResult]) -> DeactivationPlan {
    let mut by_origin: BTreeMap<&str, Vec<&SendResult>> = BTreeMap::new();
    for r in results {
        by_origin.entry(r.origin).or_default().push(r);
    }

    let mut invalid = 0usize;
    let mut candidates: BTreeSet<Deactivation> = BTreeSet::new();
    let mut held: BTreeSet<Deactivation> = BTreeSet::new();
    for rows in by_origin.values() {
        // Distinct subscriptions with usable ids, and the rows whose ids are
        // not (each one a send of its own: it cannot be told apart from another).
        let mut pairs: BTreeSet<(&str, &str)> = BTreeSet::new();
        let mut unusable_rows = 0usize;
        let mut expired: BTreeSet<Deactivation> = BTreeSet::new();
        for r in rows {
            let usable = is_target_id(r.person_id) && is_target_id(r.subscription_id);
            if usable {
                pairs.insert((r.person_id, r.subscription_id));
            } else {
                unusable_rows += 1;
            }
            if r.outcome == Outcome::Expired {
                if usable {
                    expired.insert(Deactivation {
                        person_id: r.person_id.to_string(),
                        subscription_id: r.subscription_id.to_string(),
                    });
                } else {
                    // Only an id that had to be used is worth counting.
                    invalid += 1;
                }
            }
        }
        let sends = pairs.len() + unusable_rows;
        let refused_everything = rows.iter().all(|r| r.outcome == Outcome::Expired);
        if sends >= GUARD_MIN_BATCH && refused_everything {
            held.extend(expired);
        } else {
            candidates.extend(expired);
        }
    }
    // A subscription reported under two services and believed under one is
    // believed: it is not also "held back".
    held.retain(|d| !candidates.contains(d));

    let list: Vec<Deactivation> = candidates.into_iter().collect();
    let calls = list
        .chunks(MAX_DEACTIVATIONS_PER_CALL)
        .map(<[Deactivation]>::to_vec)
        .collect();
    DeactivationPlan {
        calls,
        held_back: held.len(),
        invalid,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer<'a>(http: u16, result: Option<&'a str>, status: Option<&'a str>) -> ClaimAnswer<'a> {
        ClaimAnswer {
            http_status: http,
            result,
            status,
        }
    }

    #[test]
    fn only_the_two_documented_answers_win_the_claim() {
        // 201: this call made the row
        assert_eq!(
            read_claim(&answer(201, Some("created"), Some("queued"))),
            Claim::Won
        );
        // 200 updated and queued: a retryable failure, claimed again
        assert_eq!(
            read_claim(&answer(200, Some("updated"), Some("queued"))),
            Claim::Won
        );
        assert!(Claim::Won.may_send());
    }

    /// Fail closed, exhaustively: across every HTTP status the API or the
    /// network can give and every body shape, a push may be sent for exactly
    /// the two documented combinations and for nothing else.
    #[test]
    fn nothing_else_may_send_across_every_status_and_body() {
        let results = [
            None,
            Some("created"),
            Some("updated"),
            Some("unchanged"),
            Some("other"),
        ];
        let statuses = [
            None,
            Some("queued"),
            Some("sent"),
            Some("gone"),
            Some("failed"),
            Some("other"),
        ];
        let mut won = 0;
        for http in 0u16..=599 {
            for result in results {
                for status in statuses {
                    let claim = read_claim(&answer(http, result, status));
                    let documented = matches!(
                        (http, result, status),
                        (201, Some("created"), Some("queued"))
                            | (200, Some("updated"), Some("queued"))
                    );
                    assert_eq!(claim.may_send(), documented, "{http} {result:?} {status:?}");
                    if claim.may_send() {
                        won += 1;
                    }
                }
            }
        }
        assert_eq!(won, 2);
    }

    #[test]
    fn a_repeat_a_finished_alert_or_a_doubtful_2xx_holds_no_claim() {
        // another tick won it first, or it is finished
        for status in ["queued", "sent", "gone", "failed"] {
            assert_eq!(
                read_claim(&answer(200, Some("unchanged"), Some(status))),
                Claim::Held,
                "{status}"
            );
        }
        // moved on, but not to `queued`: this call did not claim it
        assert_eq!(
            read_claim(&answer(200, Some("updated"), Some("sent"))),
            Claim::Held
        );
        // a 2xx whose body is missing or says something else
        assert_eq!(read_claim(&answer(200, None, None)), Claim::Held);
        assert_eq!(read_claim(&answer(201, None, None)), Claim::Held);
        assert_eq!(
            read_claim(&answer(201, Some("created"), Some("sent"))),
            Claim::Held
        );
        assert_eq!(
            read_claim(&answer(204, Some("created"), Some("queued"))),
            Claim::Held
        );
    }

    #[test]
    fn a_lost_race_or_an_unavailable_api_is_tried_again_next_tick() {
        for http in [0, 408, 409, 429, 500, 502, 503, 504, 599] {
            let c = read_claim(&answer(http, None, None));
            assert_eq!(c, Claim::Retry, "{http}");
            assert!(!c.may_send());
        }
    }

    #[test]
    fn a_refused_request_is_counted_not_retried() {
        for http in [301, 302, 400, 401, 403, 404, 413, 422, 426] {
            assert_eq!(
                read_claim(&answer(http, None, None)),
                Claim::Refused,
                "{http}"
            );
        }
    }

    #[test]
    fn claim_codes_are_unique_snake_case_words() {
        let codes = [Claim::Won, Claim::Held, Claim::Retry, Claim::Refused].map(Claim::code);
        for c in codes {
            assert!(c.bytes().all(|b| b.is_ascii_lowercase()), "{c}");
        }
        let mut sorted = codes.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), codes.len());
    }

    const FCM: &str = "fcm.googleapis.com";
    const MOZILLA: &str = "updates.push.services.mozilla.com";

    fn res_at<'a>(
        origin: &'a str,
        person: &'a str,
        sub: &'a str,
        outcome: Outcome,
    ) -> SendResult<'a> {
        SendResult {
            person_id: person,
            subscription_id: sub,
            origin,
            outcome,
        }
    }

    fn res<'a>(person: &'a str, sub: &'a str, outcome: Outcome) -> SendResult<'a> {
        res_at(FCM, person, sub, outcome)
    }

    fn pair(person: &str, sub: &str) -> Deactivation {
        Deactivation {
            person_id: person.to_string(),
            subscription_id: sub.to_string(),
        }
    }

    #[test]
    fn a_gone_subscription_is_switched_off_and_the_others_are_not() {
        let plan = plan_deactivations(&[
            res("p1", "s1", Outcome::Accepted),
            res("p2", "s2", Outcome::Expired),
            res("p3", "s3", Outcome::Retry),
            res("p4", "s4", Outcome::Failed),
        ]);
        assert_eq!(plan.calls, vec![vec![pair("p2", "s2")]]);
        assert_eq!(plan.held_back, 0);
        assert_eq!(plan.invalid, 0);
        assert_eq!(plan.total(), 1);
    }

    #[test]
    fn retry_and_failed_never_switch_anything_off() {
        let plan = plan_deactivations(&[
            res("p1", "s1", Outcome::Retry),
            res("p2", "s2", Outcome::Failed),
            res("p3", "s3", Outcome::Accepted),
        ]);
        assert_eq!(plan, DeactivationPlan::default());
    }

    #[test]
    fn a_batch_where_every_send_expired_deactivates_nothing_and_says_so() {
        // A wrong or rotated VAPID key: the push service says 403 to everyone.
        let plan = plan_deactivations(&[
            res("p1", "s1", Outcome::Expired),
            res("p2", "s2", Outcome::Expired),
            res("p3", "s3", Outcome::Expired),
        ]);
        assert!(plan.calls.is_empty());
        assert_eq!(plan.held_back, 3);
        assert_eq!(plan.total(), 0);

        // One send that was accepted shows the key works: the gone ones go.
        let plan = plan_deactivations(&[
            res("p1", "s1", Outcome::Expired),
            res("p2", "s2", Outcome::Expired),
            res("p3", "s3", Outcome::Expired),
            res("p4", "s4", Outcome::Accepted),
        ]);
        assert_eq!(plan.total(), 3);
        assert_eq!(plan.held_back, 0);
    }

    #[test]
    fn the_guard_applies_from_three_sends_and_a_lone_gone_one_is_believed() {
        assert_eq!(GUARD_MIN_BATCH, 3);
        // one send, gone: switched off
        let one = plan_deactivations(&[res("p1", "s1", Outcome::Expired)]);
        assert_eq!(one.calls, vec![vec![pair("p1", "s1")]]);
        // two sends, both gone: still believed
        let two = plan_deactivations(&[
            res("p1", "s1", Outcome::Expired),
            res("p2", "s2", Outcome::Expired),
        ]);
        assert_eq!(two.total(), 2);
        // three, all gone: held back
        let three = plan_deactivations(&[
            res("p1", "s1", Outcome::Expired),
            res("p2", "s2", Outcome::Expired),
            res("p3", "s3", Outcome::Expired),
        ]);
        assert_eq!(three.total(), 0);
        assert_eq!(three.held_back, 3);
    }

    #[test]
    fn the_guard_counts_every_send_so_a_bad_id_cannot_hide_a_wrong_key() {
        // Two valid Expired results and one with a malformed id, all refused:
        // the batch is "every send expired", so nothing goes.
        let plan = plan_deactivations(&[
            res("p1", "s1", Outcome::Expired),
            res("p2", "s2", Outcome::Expired),
            res("p3", "bad id!", Outcome::Expired),
        ]);
        assert_eq!(plan.total(), 0);
        assert_eq!(plan.held_back, 2);
        assert_eq!(plan.invalid, 1);
    }

    #[test]
    fn a_subscription_named_twice_is_switched_off_once() {
        let plan = plan_deactivations(&[
            res("p1", "s1", Outcome::Expired),
            res("p1", "s1", Outcome::Expired),
            res("p2", "s2", Outcome::Accepted),
        ]);
        assert_eq!(plan.calls, vec![vec![pair("p1", "s1")]]);
    }

    #[test]
    fn the_same_subscription_id_under_another_person_is_another_pair() {
        // The API needs the person AND the id to match; one is not the other.
        let plan = plan_deactivations(&[
            res("p2", "s1", Outcome::Expired),
            res("p1", "s1", Outcome::Expired),
            res("p3", "s9", Outcome::Accepted),
        ]);
        assert_eq!(plan.calls, vec![vec![pair("p1", "s1"), pair("p2", "s1")]]);
    }

    #[test]
    fn a_malformed_id_is_counted_and_never_copied() {
        let plan = plan_deactivations(&[
            res(
                "p1",
                "https://push.example/endpoint?secret=1",
                Outcome::Expired,
            ),
            res("", "s2", Outcome::Expired),
            res("p3", &"x".repeat(200), Outcome::Expired),
            res("p4", "s4", Outcome::Accepted),
        ]);
        assert_eq!(plan.invalid, 3);
        assert!(plan.calls.is_empty());
        let shown = format!("{plan:?}");
        assert!(!shown.contains("secret"), "{shown}");
        assert!(!shown.contains("example"), "{shown}");
    }

    #[test]
    fn calls_are_at_most_the_apis_limit_in_a_stable_order() {
        let ids: Vec<String> = (0..250).map(|i| format!("s{i:03}")).collect();
        let mut results: Vec<SendResult> =
            ids.iter().map(|s| res("p1", s, Outcome::Expired)).collect();
        results.push(res("p2", "ok", Outcome::Accepted));
        let plan = plan_deactivations(&results);
        let sizes: Vec<usize> = plan.calls.iter().map(Vec::len).collect();
        assert_eq!(sizes, [100, 100, 50]);
        assert_eq!(plan.total(), 250);
        assert!(plan
            .calls
            .iter()
            .all(|c| c.len() <= MAX_DEACTIVATIONS_PER_CALL));
        // sorted across calls
        let flat: Vec<&Deactivation> = plan.calls.iter().flatten().collect();
        assert!(flat.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn the_order_of_the_results_does_not_change_the_plan() {
        let a = [
            res("p3", "s3", Outcome::Expired),
            res("p1", "s1", Outcome::Expired),
            res("p2", "s2", Outcome::Accepted),
            res("p4", "s4", Outcome::Retry),
        ];
        let mut b = a;
        b.reverse();
        assert_eq!(plan_deactivations(&a), plan_deactivations(&b));
        let mut c = a;
        c.swap(0, 2);
        assert_eq!(plan_deactivations(&a), plan_deactivations(&c));
    }

    #[test]
    fn an_empty_batch_deactivates_nothing() {
        assert_eq!(plan_deactivations(&[]), DeactivationPlan::default());
    }
    #[test]
    fn a_service_that_refused_everything_is_not_believed_whatever_another_accepted() {
        // The audience is wrong for one push service: it answers 403 to all it
        // is sent, while another accepts the same key. The first service's
        // subscribers must not be switched off because the second one worked.
        let accepted: Vec<String> = (0..5).map(|i| format!("a{i}")).collect();
        let mut results = vec![
            res_at(MOZILLA, "p1", "s1", Outcome::Expired),
            res_at(MOZILLA, "p2", "s2", Outcome::Expired),
            res_at(MOZILLA, "p3", "s3", Outcome::Expired),
        ];
        for sub in &accepted {
            results.push(res_at(FCM, "q", sub, Outcome::Accepted));
        }
        let plan = plan_deactivations(&results);
        assert!(plan.calls.is_empty());
        assert_eq!(plan.held_back, 3);

        // One service accepting some of its own sends is a different story:
        // after a key rotation the old subscriptions are refused for ever and
        // the new ones work, and those old ones are lost.
        results.push(res_at(MOZILLA, "p4", "s4", Outcome::Accepted));
        let plan = plan_deactivations(&results);
        assert_eq!(plan.total(), 3);
        assert_eq!(plan.held_back, 0);
    }

    #[test]
    fn each_service_is_judged_on_its_own() {
        let plan = plan_deactivations(&[
            // refused everything: held back
            res_at(MOZILLA, "p1", "s1", Outcome::Expired),
            res_at(MOZILLA, "p2", "s2", Outcome::Expired),
            res_at(MOZILLA, "p3", "s3", Outcome::Expired),
            // believed: it also sent an accepted one
            res_at(FCM, "p4", "s4", Outcome::Expired),
            res_at(FCM, "p5", "s5", Outcome::Expired),
            res_at(FCM, "p6", "s6", Outcome::Expired),
            res_at(FCM, "p7", "s7", Outcome::Accepted),
        ]);
        assert_eq!(
            plan.calls,
            vec![vec![pair("p4", "s4"), pair("p5", "s5"), pair("p6", "s6")]]
        );
        assert_eq!(plan.held_back, 3);
    }

    #[test]
    fn one_subscription_reported_three_times_is_one_send() {
        // A retry loop or a fan-out bug must not look like a wrong key.
        let plan = plan_deactivations(&[
            res("p1", "s1", Outcome::Expired),
            res("p1", "s1", Outcome::Expired),
            res("p1", "s1", Outcome::Expired),
        ]);
        assert_eq!(plan.calls, vec![vec![pair("p1", "s1")]]);
        assert_eq!(plan.held_back, 0);
    }

    #[test]
    fn only_an_id_that_had_to_be_used_is_counted_invalid() {
        let plan = plan_deactivations(&[
            res("bad id", "s1", Outcome::Accepted),
            res("p2", "also bad", Outcome::Retry),
            res("p3", "s3", Outcome::Failed),
        ]);
        assert_eq!(plan, DeactivationPlan::default());
    }
}
