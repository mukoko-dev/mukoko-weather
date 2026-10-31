//! `GET /v1/status`: the system health dashboard's payload.
//!
//! Ported from `api/py/_status.py`, which probed MongoDB, Open-Meteo, the AI
//! path and two cache collections. The Workers have no database, so the checks
//! are the Workers themselves (each answers `/health` over its service
//! binding) and Open-Meteo. The payload keeps its shape:
//! `{status, enrichment, timestamp, totalLatencyMs, checks[]}`, with each check
//! `{name, status, latencyMs, message, role?}`. Tomorrow.io is enrichment
//! only (`role: "enrichment"`) and never degrades the overall status.
//!
//! Pure: the Worker passes in what each probe answered and how long it took.

use serde_json::{json, Value};

pub const OPERATIONAL: &str = "operational";
pub const DEGRADED: &str = "degraded";
pub const DOWN: &str = "down";

/// What one probe of a service-bound Worker's `/health` found.
#[derive(Debug, Clone)]
pub enum Probe {
    /// The Worker answered 200 with this body.
    Healthy(Value),
    /// It answered, but not 200.
    Status(u16),
    /// It did not answer in time, or at all.
    Unreachable,
}

/// One health-check row.
pub fn row(name: &str, status: &str, latency_ms: u64, message: &str, role: Option<&str>) -> Value {
    let mut r = json!({
        "name": name,
        "status": status,
        "latencyMs": latency_ms,
        "message": message,
    });
    if let Some(role) = role {
        r["role"] = json!(role);
    }
    r
}

fn flag(body: &Value, path: &[&str]) -> bool {
    path.iter()
        .try_fold(body, |v, k| v.get(*k))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn body_ok(body: &Value) -> bool {
    body.get("status").and_then(Value::as_str) == Some("ok")
}

/// A Worker that only has to answer `/health`.
pub fn worker_row(name: &str, probe: &Probe, latency_ms: u64) -> Value {
    match probe {
        Probe::Healthy(body) if body_ok(body) => {
            row(name, OPERATIONAL, latency_ms, "Responding normally", None)
        }
        Probe::Healthy(_) => row(
            name,
            DEGRADED,
            latency_ms,
            "Answered, but not reporting ok",
            None,
        ),
        Probe::Status(code) => row(
            name,
            DOWN,
            latency_ms,
            &format!("Unavailable (HTTP {code})"),
            None,
        ),
        Probe::Unreachable => row(name, DOWN, latency_ms, "Did not answer", None),
    }
}

/// The forecast Worker's cache and station database, from its `configured`
/// flags. Empty when the Worker did not answer (its own row says so).
pub fn forecast_storage_row(probe: &Probe, latency_ms: u64) -> Option<Value> {
    let Probe::Healthy(body) = probe else {
        return None;
    };
    let name = "Forecast cache and station data";
    let cache = flag(body, &["configured", "cache"]);
    let stations = flag(body, &["configured", "stations_db"]);
    Some(match (cache, stations) {
        (true, true) => row(
            name,
            OPERATIONAL,
            latency_ms,
            "KV cache and station database bound",
            None,
        ),
        (false, _) => row(
            name,
            DOWN,
            latency_ms,
            "The forecast cache is not bound",
            None,
        ),
        (true, false) => row(
            name,
            DEGRADED,
            latency_ms,
            "The station database is not bound; station readings are off",
            None,
        ),
    })
}

/// Tomorrow.io: enrichment only, read from the forecast Worker's config. It
/// never degrades the overall status and is never probed live (the free-tier
/// quota is the thing to protect).
pub fn enrichment_row(probe: &Probe, latency_ms: u64) -> Value {
    let name = "Tomorrow.io (insights enrichment)";
    let role = Some("enrichment");
    match probe {
        Probe::Healthy(body) if flag(body, &["configured", "tomorrow"]) => {
            // The forecast Worker's budget snapshot (a count of its own D1
            // rows, no Tomorrow.io call): free tier, never the baseline.
            let n = |k: &str| {
                body.get("enrichment")
                    .and_then(|e| e.get(k))
                    .and_then(Value::as_u64)
            };
            let message = match (n("hourUsed"), n("hourCapNormal"), n("dayUsed"), n("dayCapNormal")) {
                (Some(h), Some(hc), Some(d), Some(dc)) => format!(
                    "Insights enrichment only, free tier. Calls: {h}/{hc} this hour, {d}/{dc} in 24 h (normal traffic caps). The Open-Meteo blend is the baseline"
                ),
                _ => "Insights enrichment only, free tier. Key configured; the Open-Meteo blend is the baseline".to_owned(),
            };
            row(name, OPERATIONAL, latency_ms, &message, role)
        }
        Probe::Healthy(_) => row(
            name,
            DEGRADED,
            latency_ms,
            "Enrichment off: no API key configured. Baseline and derived insights unaffected.",
            role,
        ),
        _ => row(
            name,
            DEGRADED,
            latency_ms,
            "Enrichment unknown: the forecast Worker did not answer; derived insights in use",
            role,
        ),
    }
}

/// Shamwari: the AI Worker's `/health` (no model call, so no tokens spent).
pub fn ai_row(probe: &Probe, latency_ms: u64) -> Value {
    let name = "Shamwari AI (weather AI Worker)";
    match probe {
        Probe::Healthy(body) if body_ok(body) && flag(body, &["ai"]) => row(
            name,
            OPERATIONAL,
            latency_ms,
            "AI Worker reachable, Workers AI bound",
            None,
        ),
        Probe::Healthy(_) => row(
            name,
            DEGRADED,
            latency_ms,
            "AI Worker reachable, but Workers AI is not bound; basic summary fallback active",
            None,
        ),
        Probe::Status(code) => row(
            name,
            DOWN,
            latency_ms,
            &format!("AI Worker unavailable (HTTP {code}); fallbacks active"),
            None,
        ),
        Probe::Unreachable => row(
            name,
            DOWN,
            latency_ms,
            "AI Worker did not answer; fallbacks active",
            None,
        ),
    }
}

/// Open-Meteo: a real forecast request for Harare. `None` temperature means
/// the answer came but carried no data.
pub fn open_meteo_row(outcome: Result<Option<f64>, u16>, latency_ms: u64) -> Value {
    let name = "Open-Meteo API";
    match outcome {
        Ok(Some(_)) => row(name, OPERATIONAL, latency_ms, "Responding normally", None),
        Ok(None) => row(
            name,
            DEGRADED,
            latency_ms,
            "Response received but missing expected data",
            None,
        ),
        Err(0) => row(name, DOWN, latency_ms, "Did not answer", None),
        Err(code) => row(name, DOWN, latency_ms, &format!("HTTP {code}"), None),
    }
}

/// The overall status: `degraded` when any core (non-enrichment) check is not
/// operational.
pub fn overall(checks: &[Value]) -> &'static str {
    let bad = checks
        .iter()
        .filter(|c| c.get("role").and_then(Value::as_str) != Some("enrichment"))
        .any(|c| matches!(c["status"].as_str(), Some(DOWN | DEGRADED)));
    if bad {
        DEGRADED
    } else {
        OPERATIONAL
    }
}

/// `degraded` when any enrichment row is not operational.
pub fn enrichment(checks: &[Value]) -> &'static str {
    let bad = checks
        .iter()
        .filter(|c| c.get("role").and_then(Value::as_str) == Some("enrichment"))
        .any(|c| c["status"].as_str() != Some(OPERATIONAL));
    if bad {
        DEGRADED
    } else {
        OPERATIONAL
    }
}

/// The whole payload.
pub fn payload(checks: Vec<Value>, timestamp: &str, total_latency_ms: u64) -> Value {
    json!({
        "status": overall(&checks),
        "enrichment": enrichment(&checks),
        "timestamp": timestamp,
        "totalLatencyMs": total_latency_ms,
        "checks": checks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn healthy(body: Value) -> Probe {
        Probe::Healthy(body)
    }

    #[test]
    fn a_healthy_worker_is_operational_and_a_failed_one_is_down() {
        let ok = worker_row("Places Worker", &healthy(json!({"status": "ok"})), 12);
        assert_eq!(ok["status"], OPERATIONAL);
        assert_eq!(ok["latencyMs"], 12);
        assert!(ok.get("role").is_none());
        assert_eq!(worker_row("x", &Probe::Status(503), 1)["status"], DOWN);
        assert_eq!(worker_row("x", &Probe::Unreachable, 1)["status"], DOWN);
        assert_eq!(
            worker_row("x", &healthy(json!({"status": "starting"})), 1)["status"],
            DEGRADED
        );
    }

    #[test]
    fn forecast_storage_reads_the_configured_flags() {
        let both = healthy(json!({"configured": {"cache": true, "stations_db": true}}));
        assert_eq!(
            forecast_storage_row(&both, 1).unwrap()["status"],
            OPERATIONAL
        );
        let no_cache = healthy(json!({"configured": {"cache": false, "stations_db": true}}));
        assert_eq!(forecast_storage_row(&no_cache, 1).unwrap()["status"], DOWN);
        let no_db = healthy(json!({"configured": {"cache": true, "stations_db": false}}));
        assert_eq!(forecast_storage_row(&no_db, 1).unwrap()["status"], DEGRADED);
        assert!(forecast_storage_row(&Probe::Unreachable, 1).is_none());
    }

    #[test]
    fn enrichment_never_degrades_the_overall_status() {
        let off = enrichment_row(&healthy(json!({"configured": {"tomorrow": false}})), 3);
        assert_eq!(off["status"], DEGRADED);
        assert_eq!(off["role"], "enrichment");
        let core = row("Core", OPERATIONAL, 1, "ok", None);
        let checks = vec![core, off];
        assert_eq!(overall(&checks), OPERATIONAL);
        assert_eq!(enrichment(&checks), DEGRADED);
    }

    #[test]
    fn enrichment_is_reported_as_enrichment_with_its_budget() {
        let on = enrichment_row(
            &healthy(json!({
                "configured": {"tomorrow": true},
                "enrichment": {"role": "enrichment", "hourUsed": 3, "hourCapNormal": 12,
                               "dayUsed": 40, "dayCapNormal": 250},
            })),
            2,
        );
        assert_eq!(on["status"], OPERATIONAL);
        assert_eq!(on["role"], "enrichment");
        let m = on["message"].as_str().unwrap();
        assert!(
            m.contains("3/12 this hour") && m.contains("40/250 in 24 h"),
            "{m}"
        );
        assert!(m.contains("blend is the baseline"), "{m}");
        // Without a budget snapshot (D1 unreadable) the row still says what it is.
        let bare = enrichment_row(&healthy(json!({"configured": {"tomorrow": true}})), 2);
        assert!(bare["message"]
            .as_str()
            .unwrap()
            .contains("enrichment only"));
    }

    #[test]
    fn a_failing_core_check_degrades_the_overall_status() {
        let checks = vec![
            row("A", OPERATIONAL, 1, "ok", None),
            row("B", DOWN, 1, "no", None),
        ];
        assert_eq!(overall(&checks), DEGRADED);
        assert_eq!(enrichment(&checks), OPERATIONAL);
    }

    #[test]
    fn the_ai_row_needs_workers_ai_bound() {
        let ok = ai_row(&healthy(json!({"status": "ok", "ai": true})), 4);
        assert_eq!(ok["status"], OPERATIONAL);
        let unbound = ai_row(&healthy(json!({"status": "ok", "ai": false})), 4);
        assert_eq!(unbound["status"], DEGRADED);
        assert_eq!(ai_row(&Probe::Status(500), 4)["status"], DOWN);
    }

    #[test]
    fn open_meteo_rows_distinguish_no_answer_bad_status_and_empty_data() {
        assert_eq!(open_meteo_row(Ok(Some(21.0)), 5)["status"], OPERATIONAL);
        assert_eq!(open_meteo_row(Ok(None), 5)["status"], DEGRADED);
        assert_eq!(open_meteo_row(Err(0), 5)["message"], "Did not answer");
        assert_eq!(open_meteo_row(Err(429), 5)["message"], "HTTP 429");
    }

    #[test]
    fn the_payload_keeps_the_dashboards_shape() {
        let p = payload(
            vec![row("A", OPERATIONAL, 1, "ok", None)],
            "2026-10-18T00:00:00Z",
            9,
        );
        for key in [
            "status",
            "enrichment",
            "timestamp",
            "totalLatencyMs",
            "checks",
        ] {
            assert!(p.get(key).is_some(), "{key}");
        }
        assert_eq!(p["status"], OPERATIONAL);
        assert_eq!(p["checks"].as_array().unwrap().len(), 1);
    }
}
