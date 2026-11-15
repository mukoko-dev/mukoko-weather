//! Tripwires on `workers/push` (`mukoko-weather-push`), the Workers-runtime
//! half of the sender, and on its one caller, the alert tick in
//! `workers/jobs` (mukoko-dev/mukoko-weather#289, #579).
//!
//! These crates wrap `crypto.subtle`, `fetch` and Worker bindings, so they
//! cannot run natively. These tests read their source, their `wrangler.jsonc`
//! files and the workflows: a tripwire that the glue uses the pure rules in
//! [`crate::runtime`] and `weather_core::push_wire`, keeps to the limits in its
//! module docs, and keeps the SAFE SHAPE of device push. They are not behaviour
//! tests (the first real send, which is the owner's gate, is the first run in a
//! Workers runtime and against a push service); they stop the easy mistakes:
//! following a redirect, reading the answer's body, sending a header the rules
//! do not name, exporting a private key, logging an endpoint, a second route on
//! the sender, a public address for it, a secret read outside its entry, a push
//! before the claim is won, a switch that defaults on.
//!
//! The shape pinned today: ONE `/send` route; reachable only through the jobs
//! service binding AND a service key; no route, no `workers.dev`; the VAPID key
//! read only in the entry and passed as a value; nothing that could carry an
//! endpoint, a key or a body in a log line; the alert tick off unless
//! `ALERTS_ENABLED` is `true`, claiming each alert before it pushes.
//!
//! Comment lines are ignored, so the glue can explain itself.
//!
//! **History.** Until #579 these tests pinned the sender DARK (one `/health`
//! route, no secret, no binding, not in the deploy). The PR that built the send
//! path replaced them, in the open, with the stricter ones below.

const TRANSPORT: &str = include_str!("../../../push/src/transport.rs");
const WEBCRYPTO: &str = include_str!("../../../push/src/webcrypto.rs");
const WORKER: &str = include_str!("../../../push/src/lib.rs");
const WRANGLER: &str = include_str!("../../../push/wrangler.jsonc");
const PUSH_MANIFEST: &str = include_str!("../../../push/Cargo.toml");
const LOCKFILE: &str = include_str!("../../../Cargo.lock");
const CI: &str = include_str!("../../../../.github/workflows/workers.yml");
const DEPLOY: &str = include_str!("../../../../.github/workflows/workers-deploy.yml");
const SEND: &str = include_str!("../../../push/src/send.rs");
const RANDOM: &str = include_str!("../../../push/src/random.rs");
const JOBS_ALERTS: &str = include_str!("../../../jobs/src/alerts.rs");
const JOBS_LIB: &str = include_str!("../../../jobs/src/lib.rs");
const JOBS_WRANGLER: &str = include_str!("../../../jobs/wrangler.jsonc");
const JOBS_MANIFEST: &str = include_str!("../../../jobs/Cargo.toml");

/// `src` without its comment lines (`//`, `///`, `//!`), so the glue can
/// explain itself without tripping a scan for what it must not do.
fn code(src: &str) -> String {
    src.lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn assert_absent(code: &str, banned: &[&str]) {
    for b in banned {
        assert!(!code.contains(b), "{b}");
    }
}

fn assert_present(code: &str, needed: &[&str]) {
    for n in needed {
        assert!(code.contains(n), "{n}");
    }
}

/// Where `needle` first appears in `haystack`; panics with the needle if not.
fn at(haystack: &str, needle: &str) -> usize {
    haystack
        .find(needle)
        .unwrap_or_else(|| panic!("missing: {needle}"))
}

/// Every double-quoted literal that comes straight after `prefix`.
fn literals_after(code: &str, prefix: &str) -> Vec<String> {
    code.match_indices(prefix)
        .map(|(i, _)| {
            let rest = &code[i + prefix.len()..];
            rest[..rest.find('"').expect("a closing quote")].to_string()
        })
        .collect()
}

mod transport {
    use super::*;

    #[test]
    fn asks_for_manual_redirects_and_nothing_else() {
        let code = code(TRANSPORT);
        assert!(code.contains("RequestRedirect::Manual"), "redirect: manual");
        assert_eq!(
            code.matches("RequestRedirect::").count(),
            code.matches("RequestRedirect::Manual").count(),
            "no other redirect mode"
        );
    }

    #[test]
    fn sends_one_post_with_a_signal_and_no_edge_options() {
        let code = code(TRANSPORT);
        assert!(code.contains("Method::Post"));
        assert_eq!(
            code.matches("Method::").count(),
            code.matches("Method::Post").count(),
            "only POST"
        );
        assert!(
            code.contains("send_with_signal"),
            "the abort signal is passed"
        );
        assert_absent(&code, &["with_cf_properties", "Fetch::Url"]);
    }

    #[test]
    fn uses_the_pure_rules() {
        let code = code(TRANSPORT);
        assert_present(
            &code,
            &[
                "check_request(",
                "with_deadline(",
                "reads_retry_after(",
                "retry_after_secs(",
                "impl Transport for",
            ],
        );
    }

    #[test]
    fn checks_the_request_before_it_builds_anything_for_fetch() {
        let code = code(TRANSPORT);
        let post = &code[at(&code, "async fn post_with_hint")..];
        assert!(
            at(post, "check_request(") < at(post, "exchange("),
            "the check comes before the exchange"
        );
        assert!(
            at(&code, "check_request(") < at(&code, "Headers::new()"),
            "nothing is built for fetch before the check"
        );
    }

    #[test]
    fn never_reads_the_body_of_the_answer() {
        let code = code(TRANSPORT);
        assert_absent(
            &code,
            &[
                ".text(",
                ".bytes(",
                ".json(",
                ".array_buffer(",
                ".form_data(",
                ".stream(",
                ".body(",
                "ByteStream",
                "ReadableStream",
                "read_bounded",
                "StreamExt",
            ],
        );
    }

    #[test]
    fn reads_one_header_of_the_answer_and_only_for_429_and_5xx() {
        let code = code(TRANSPORT);
        assert_eq!(
            literals_after(&code, ".get(\""),
            vec!["retry-after".to_string()],
            "the only header read is Retry-After"
        );
        assert_eq!(code.matches(".headers()").count(), 1);
        assert!(
            at(&code, "reads_retry_after(") < at(&code, "\"retry-after\""),
            "the header is read only where the rules read it"
        );
    }

    #[test]
    fn releases_the_connection_after_the_status_and_the_one_header() {
        let code = code(TRANSPORT);
        let exchange = &code[at(&code, "async fn exchange")..];
        assert!(
            at(exchange, "send_with_signal") < at(exchange, "aborter.abort()"),
            "the request is aborted once it has answered"
        );
        assert!(
            at(exchange, "\"retry-after\"") < at(exchange, "aborter.abort()"),
            "the header is read before the connection is released"
        );
    }

    #[test]
    fn adds_no_credentials_of_its_own() {
        let code = code(TRANSPORT).to_ascii_lowercase();
        assert_absent(
            &code,
            &[
                "authorization",
                "cookie",
                "credentials",
                "bearer",
                "api-key",
                "apikey",
                "x-api",
                "secret(",
                "env.",
                "user-agent",
            ],
        );
    }

    #[test]
    fn sets_only_the_requests_own_headers() {
        let code = code(TRANSPORT);
        assert_eq!(
            code.matches(".set(").count(),
            1,
            "one header write: the loop over the request's checked headers"
        );
        assert_present(&code, &["for (name, value) in &req.headers"]);
    }

    #[test]
    fn logs_nothing_and_formats_nothing() {
        assert_no_logging(&code(TRANSPORT));
    }
}

mod webcrypto {
    use super::*;

    #[test]
    fn uses_the_pure_checks_on_what_webcrypto_returns() {
        let code = code(WEBCRYPTO);
        assert_present(
            &code,
            &[
                "agreement_from_parts(",
                "signature_from_bytes(",
                "import_error(",
                "VapidKeyMaterial::parse(",
                "KEY_PROBE",
                "impl KeyAgreement for",
                "impl Es256Signer for",
            ],
        );
    }

    #[test]
    fn no_key_is_extractable() {
        let code = code(WEBCRYPTO);
        // Every key made or imported here is non-extractable: the argument is
        // `false`, and `true` appears nowhere in the file.
        assert!(!code.contains("true"), "no extractable key");
        assert_absent(&code, &["extractable", "pkcs8", "\"jwk\", &"]);
        assert_eq!(
            code.matches("import_key_with_object(").count(),
            3,
            "the browser's key, the VAPID private key, its public key"
        );
        assert_eq!(
            code.matches("false,").count(),
            4,
            "the three imports and the ephemeral pair, all non-extractable"
        );
    }

    #[test]
    fn only_a_public_key_is_ever_exported() {
        let code = code(WEBCRYPTO);
        assert_eq!(code.matches("export_key(").count(), 1);
        let export = &code[at(&code, "export_key(")..];
        assert!(
            export.starts_with("export_key(\"raw\", &pair.get_public_key())"),
            "the one export is the raw public key of the ephemeral pair"
        );
        assert_eq!(
            code.matches("get_private_key()").count(),
            1,
            "the ephemeral private key is used once, for deriveBits"
        );
        assert!(
            code[at(&code, "get_private_key()") - 80..at(&code, "get_private_key()")]
                .contains("derive_bits_with_object("),
            "and only there"
        );
    }

    #[test]
    fn makes_one_ephemeral_ecdh_pair_and_no_long_lived_key() {
        let code = code(WEBCRYPTO);
        assert_eq!(code.matches("generate_key_with_object(").count(), 1);
        assert!(
            code[at(&code, "generate_key_with_object(")..]
                .starts_with("generate_key_with_object(&ecdh()"),
            "the one generated key is an ECDH pair"
        );
        assert_absent(
            &code,
            &["get_random_values", "random_uuid", "getRandomValues"],
        );
    }

    #[test]
    fn the_signer_proves_its_pair_before_it_exists() {
        let code = code(WEBCRYPTO);
        let import = &code[at(&code, "pub async fn import(")..];
        assert!(
            at(import, "sign_with_object_and_u8_array(")
                < at(import, "verify_with_object_and_u8_array_and_u8_array("),
            "a probe is signed, then verified with the public key"
        );
        assert!(
            at(import, "verify_with_object_and_u8_array_and_u8_array(") < at(import, "Ok(Self {"),
            "the signer is returned only after the check"
        );
        assert_present(&code, &["KeyError::Mismatch"]);
    }

    #[test]
    fn the_signer_has_a_redacted_debug_and_no_derive() {
        let code = code(WEBCRYPTO);
        let at_struct = at(&code, "pub struct WebCryptoSigner");
        let before = &code[at_struct.saturating_sub(120)..at_struct];
        assert!(
            !before.contains("derive("),
            "no derive on the struct that holds the key"
        );
        assert!(code.contains("WebCryptoSigner(<redacted>)"));
        assert!(code.contains("impl std::fmt::Debug for WebCryptoSigner"));
    }

    #[test]
    fn holds_no_secret_binding_and_reads_no_environment() {
        let code = code(WEBCRYPTO);
        assert_absent(
            &code,
            &[
                "Env",
                "env.",
                "secret(",
                ".secret",
                ".var(",
                "Secret",
                "localStorage",
                "Fetch",
            ],
        );
    }

    #[test]
    fn error_names_are_read_but_never_their_messages() {
        let code = code(WEBCRYPTO);
        assert_present(&code, &["\"name\""]);
        assert_absent(&code, &["\"message\"", ".message(", "to_string()"]);
        assert_eq!(
            code.matches(".as_string()").count(),
            1,
            "one string is read from a JS error: its name"
        );
    }

    #[test]
    fn logs_nothing_and_formats_nothing() {
        assert_no_logging(&code(WEBCRYPTO));
    }
}

fn assert_no_logging(code: &str) {
    assert_absent(
        code,
        &[
            "console_log!",
            "console_warn!",
            "console_error!",
            "console_debug!",
            "console::",
            "println!",
            "eprintln!",
            "dbg!",
            "tracing::",
            "log::",
            "format!(",
            "{:?}",
            "{:#?}",
            ".unwrap(",
            ".expect(",
            "panic!",
        ],
    );
}

/// Each `needle(`-call's text, from the needle to the first `);` after it, so a
/// check can look at what a log call is given.
fn calls_of<'a>(code: &'a str, needle: &str) -> Vec<&'a str> {
    code.match_indices(needle)
        .map(|(i, _)| {
            let rest = &code[i..];
            &rest[..rest.find(");").map_or(rest.len(), |e| e + 2)]
        })
        .collect()
}

/// `call` with its string literals emptied, so the words of a log message are
/// not mistaken for the identifiers it is given.
fn without_strings(call: &str) -> String {
    let mut out = String::new();
    let mut inside = false;
    for c in call.chars() {
        if c == '"' {
            inside = !inside;
        } else if !inside {
            out.push(c);
        }
    }
    out
}

/// The sender's shape: ONE `/send` route, reachable only by the jobs service
/// binding and a service key, the secrets read in the entry and passed on as
/// values, nothing logged that could carry an endpoint, a key or a body.
///
/// These replaced the tests of the earlier DARK shape (one `/health` route, no
/// secret, no binding, not in the deploy), in the open, when #579 built the
/// send path. They are stricter where the new code can do more harm: the
/// route list is pinned, not just banned from growing a "/send"; the secrets
/// are pinned to the entry file by name; the order of the checks in `/send` is
/// pinned.
mod sender {
    use super::*;

    #[test]
    fn the_worker_has_one_fetch_handler_and_no_other_entry_point() {
        let code = code(WORKER);
        assert_eq!(code.matches("#[event(").count(), 1);
        assert!(code.contains("#[event(fetch)]"));
        assert_absent(&code, &["scheduled", "#[event(queue)]", "email", "tail"]);
    }

    #[test]
    fn exactly_two_routes_health_by_get_and_send_by_post() {
        let code = code(WORKER);
        let mut routes = literals_after(&code, "(\"/");
        routes.sort();
        assert_eq!(
            routes,
            ["health", "health", "send", "send"],
            "each route and the 405 for every other method"
        );
        assert_eq!(code.matches("Method::Post").count(), 1, "one POST route");
        assert_eq!(code.matches("Method::Get").count(), 1, "one GET route");
        for banned in [
            "\"/internal",
            "\"/v1",
            "\"/push",
            "\"/subscribe",
            "\"/vapid",
        ] {
            assert!(!code.contains(banned), "{banned}");
        }
        assert_present(
            &code,
            &["(\"/send\", Method::Post)", "(\"/health\", Method::Get)"],
        );
    }

    #[test]
    fn the_caller_is_checked_before_anything_is_read_or_configured() {
        let code = code(WORKER);
        let route = &code[at(&code, "async fn send_route")..];
        let gate = at(route, "gate(");
        assert!(
            gate < at(route, "secret(env, VAPID_PRIVATE_KEY)"),
            "key before the VAPID key"
        );
        assert!(gate < at(route, "config(env, \"VAPID_PUBLIC_KEY\")"));
        assert!(gate < at(route, "req.bytes()"), "the key before the body");
        assert!(gate < at(route, "send::send("));
        assert_present(
            route,
            &[
                "Gate::Allowed",
                "Gate::NotConfigured",
                "Gate::Unauthorized",
                "503",
                "401",
            ],
        );
    }

    #[test]
    fn a_body_is_bounded_before_and_after_it_is_read() {
        let code = code(WORKER);
        let route = &code[at(&code, "async fn send_route")..];
        assert_eq!(route.matches("MAX_SEND_BODY_BYTES").count(), 2);
        assert!(at(route, "Content-Length") < at(route, "req.bytes()"));
        assert!(at(route, "req.bytes()") < at(route, "body.len() >"));
        assert!(at(route, "body.len() >") < at(route, "send::send("));
    }

    #[test]
    fn the_two_secrets_are_read_in_the_entry_and_nowhere_else() {
        let entry = code(WORKER);
        assert_eq!(
            entry.matches("secret(env,").count(),
            2,
            "the send key and the VAPID key"
        );
        assert_present(
            &entry,
            &[
                "secret(env, PUSH_SEND_KEY)",
                "secret(env, VAPID_PRIVATE_KEY)",
                "config(env, \"VAPID_PUBLIC_KEY\")",
                "config(env, \"VAPID_SUBJECT\")",
            ],
        );
        // Every other file is handed values and reads no environment.
        for (name, src) in [
            ("send.rs", SEND),
            ("random.rs", RANDOM),
            ("transport.rs", TRANSPORT),
            ("webcrypto.rs", WEBCRYPTO),
        ] {
            let c = code_of(src);
            assert_absent(
                &c,
                &[
                    "Env",
                    "env.",
                    "secret(",
                    "config(",
                    ".var(",
                    ".secret",
                    "Secret",
                    "PUSH_SEND_KEY",
                    "VAPID_PRIVATE_KEY",
                    "VAPID_PUBLIC_KEY",
                    "VAPID_SUBJECT",
                ],
            );
            assert!(!c.is_empty(), "{name}");
        }
    }

    // `code` above is shadowed by the local binding in some tests; this is the
    // same function under a name that cannot be.
    fn code_of(src: &str) -> String {
        super::code(src)
    }

    #[test]
    fn the_key_and_contact_reach_the_sender_as_values() {
        let entry = code(WORKER);
        assert_present(&entry, &["send::send(&body, &private, &public, &subject,"]);
        let send = code(SEND);
        assert_present(
            &send,
            &[
                "vapid_private: &str",
                "vapid_public: &str",
                "subject: &str",
                "now_unix: u64",
            ],
        );
    }

    #[test]
    fn the_entry_reaches_nothing_and_builds_no_crypto() {
        assert_absent(
            &code(WORKER),
            &[
                ".kv(",
                ".d1(",
                ".bucket(",
                ".service(",
                ".queue(",
                "durable_object",
                "Fetch",
                "transport::Worker",
                "WebCryptoSigner::import",
                "WebCryptoKeyAgreement",
                "subtle",
            ],
        );
    }

    #[test]
    fn the_entry_logs_only_a_stable_code_through_the_throttle() {
        let entry = code(WORKER);
        assert_no_console(&entry);
        assert_absent(
            &entry,
            &[
                "format!(", "{:?}", "{:#?}", ".unwrap(", ".expect(", "panic!",
            ],
        );
        let calls = calls_of(&entry, "log_throttled(");
        assert!(!calls.is_empty());
        for call in &calls {
            let call = without_strings(call);
            for ident in [
                "body",
                "private",
                "public",
                "subject",
                "req",
                "presented",
                "expected",
                "secret",
            ] {
                assert!(
                    !call
                        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
                        .any(|w| w == ident),
                    "a log call names `{ident}`: {call}"
                );
            }
        }
    }

    #[test]
    fn the_checks_in_send_come_in_the_safe_order() {
        let send = code(SEND);
        let parse = at(&send, "parse_send(");
        let import = at(&send, "WebCryptoSigner::import(");
        let salt = at(&send, "random::salt()");
        let go = at(&send, "request::send(");
        assert!(
            parse < import && import < salt && salt < go,
            "the body is checked before a key is imported, the key before a salt, all before a send"
        );
        assert_present(&send, &["WorkerPushTransport", "WebCryptoKeyAgreement"]);
        assert_absent(&send, &["Fetch", "Request::new", "Headers"]);
    }

    #[test]
    fn a_subscription_that_cannot_be_used_is_one_failed_send_and_everything_else_is_ours() {
        let send = code(SEND);
        assert_present(
            &send,
            &[
                "subscription_is_unusable()",
                "Outcome::Failed",
                "reason: Some(e.code())",
                "status: UNAVAILABLE",
                "status: BAD_REQUEST",
            ],
        );
        assert_absent(&send, &["e.to_string()", "{e}", "{e:?}"]);
    }

    #[test]
    fn the_sender_modules_log_nothing_and_format_nothing() {
        assert_no_logging(&code(SEND));
        assert_no_logging(&code(RANDOM));
    }

    #[test]
    fn the_salt_is_sixteen_octets_from_the_runtime_and_nothing_else_draws_a_number() {
        let random = code(RANDOM);
        assert_eq!(
            random.matches("get_random_values_with_u8_array(").count(),
            1
        );
        assert_present(&random, &["[0u8; 16]"]);
        for src in [SEND, TRANSPORT, WEBCRYPTO, WORKER] {
            assert_absent(
                &code(src),
                &[
                    "get_random_values",
                    "getRandomValues",
                    "random_uuid",
                    "Math.random",
                ],
            );
        }
    }

    #[test]
    fn the_wire_ttl_bound_is_the_requests() {
        assert_eq!(
            weather_core::push_wire::MAX_SEND_TTL_SECONDS,
            crate::request::MAX_TTL_SECS,
            "the sender shortens a TTL to exactly what the request builder allows"
        );
    }

    #[test]
    fn wrangler_has_no_schedule_no_route_no_binding_but_the_two_secrets() {
        let config = code(WRANGLER);
        assert_absent(
            &config,
            &[
                "\"triggers\"",
                "\"crons\"",
                "\"routes\"",
                "\"route\"",
                "\"services\"",
                "\"d1_databases\"",
                "\"kv_namespaces\"",
                "\"r2_buckets\"",
                "\"queues\"",
                "\"durable_objects\"",
                "\"ai\"",
                "\"hyperdrive\"",
                "\"analytics_engine_datasets\"",
                "\"rate_limits\"",
                "\"unsafe\"",
                "\"vectorize\"",
                "\"send_email\"",
                "\"custom_domain\"",
            ],
        );
        assert_present(
            &config,
            &[
                "\"name\": \"mukoko-weather-push\"",
                "\"workers_dev\": false",
                "\"preview_urls\": false",
                "\"secrets_store_secrets\"",
            ],
        );
    }

    #[test]
    fn wrangler_binds_exactly_the_vapid_key_and_the_send_key_from_the_account_store() {
        let config = code(WRANGLER);
        let names = literals_after(&config, "\"secret_name\": \"");
        assert_eq!(
            names,
            [
                "MUKOKO_WEATHER_VAPID_PRIVATE_KEY",
                "MUKOKO_WEATHER_PUSH_SEND_KEY"
            ]
        );
        assert_eq!(
            literals_after(&config, "\"store_id\": \""),
            [weather_core::secrets::STORE_ID; 2]
        );
    }

    #[test]
    fn wrangler_vars_are_the_public_half_and_the_contact_never_a_private_key() {
        let config = code(WRANGLER);
        let vars = &config[at(&config, "\"vars\"")..at(&config, "\"secrets_store_secrets\"")];
        let names = literals_after(vars, "\"VAPID_");
        assert_eq!(
            names,
            ["PUBLIC_KEY", "SUBJECT"],
            "no other var, and none for a private key"
        );
        assert!(!vars.contains("PRIVATE"));
        // Shipped empty (the owner's), or an 87-character public point, or a
        // contact URI: never anything else, and never a key's length.
        let public = literals_after(vars, "\"VAPID_PUBLIC_KEY\": \"");
        assert!(
            public[0].is_empty() || (public[0].len() == 87 && public[0].starts_with('B')),
            "an empty var, or an uncompressed P-256 point"
        );
        let subject = literals_after(vars, "\"VAPID_SUBJECT\": \"");
        assert!(
            subject[0].is_empty()
                || subject[0].starts_with("mailto:")
                || subject[0].starts_with("https://")
        );
    }

    #[test]
    fn the_crate_depends_on_no_curve_crate_and_no_rng() {
        let manifest = code(PUSH_MANIFEST);
        assert_absent(
            &manifest,
            &[
                "getrandom",
                "rand",
                "p256",
                "ecdsa",
                "k256",
                "elliptic-curve",
                "crypto-bigint",
                "web-push",
            ],
        );
        // RUSTSEC-2026-0387: nothing in the workspace may bring the
        // RustCrypto curve chain back. ECDH and ECDSA are the runtime's.
        for package in [
            "p256",
            "k256",
            "ecdsa",
            "elliptic-curve",
            "primeorder",
            "crypto-bigint",
        ] {
            assert!(
                !LOCKFILE.contains(&format!("name = \"{package}\"")),
                "{package} is in Cargo.lock"
            );
        }
    }
}

fn assert_no_console(code: &str) {
    assert_absent(
        code,
        &[
            "console_log!",
            "console_warn!",
            "console_error!",
            "console_debug!",
            "console::",
            "println!",
            "eprintln!",
            "dbg!",
            "tracing::",
            "log::",
        ],
    );
}

/// The caller: the alert tick in `mukoko-weather-jobs`. It is the one Worker
/// that holds an endpoint and its keys in the clear, so its shape is pinned
/// too: nothing without the switch, a claim before every push, and no
/// subscription detail in any log line.
mod caller {
    use super::*;

    #[test]
    fn nothing_happens_without_the_switch_and_it_ships_off() {
        let alerts = code(JOBS_ALERTS);
        assert!(
            at(&alerts, "alerts_enabled()") < at(&alerts, "resolve_seed("),
            "the switch is the first thing the job asks"
        );
        assert!(at(&alerts, "alerts_enabled()") < at(&alerts, "assess_place("));
        let lib = code(JOBS_LIB);
        assert_present(
            &lib,
            &[
                "Tick::Alerts",
                "alerts_enabled()",
                "ALERTS_ENABLED",
                "return;",
            ],
        );
        assert!(
            at(&lib, "alerts_enabled()") < at(&lib, "plan(tick"),
            "the tick says so and queues nothing before it plans"
        );
        let config = code(JOBS_WRANGLER);
        assert_present(&config, &["\"ALERTS_ENABLED\": \"false\""]);
        assert_eq!(config.matches("\"ALERTS_ENABLED\"").count(), 1);
    }

    #[test]
    fn a_push_is_sent_only_after_the_claim_is_won() {
        let alerts = code(JOBS_ALERTS);
        let claim = at(&alerts, "read_claim(");
        let guard = at(&alerts, "claim != Claim::Won");
        let push = at(&alerts, "push_send(env, &send_key");
        assert!(
            claim < guard && guard < push,
            "claim, then the guard, then the push"
        );
        let after_guard = &alerts[guard..push];
        assert!(
            after_guard.contains("continue"),
            "anything but a won claim moves on to the next target"
        );
        assert_eq!(
            alerts.matches("push_send(").count(),
            2,
            "its definition and its one call"
        );
        assert_eq!(alerts.matches("encode_send(").count(), 1);
        assert!(
            at(&alerts, "encode_send(") > guard,
            "the endpoint is not even read before the claim is won"
        );
    }

    #[test]
    fn the_outcome_is_logged_on_the_same_row_after_the_push() {
        let alerts = code(JOBS_ALERTS);
        let push = at(&alerts, "push_send(env, &send_key");
        let log = at(&alerts, "outcome.delivery_status()");
        assert!(push < log);
        assert_present(&alerts, &["status: \"queued\""]);
        assert_eq!(alerts.matches("status: \"queued\"").count(), 1, "one claim");
    }

    #[test]
    fn a_subscription_endpoint_is_only_ever_given_to_the_sender_and_the_origin_check() {
        let alerts = code(JOBS_ALERTS);
        let uses: Vec<usize> = alerts
            .match_indices("sub.endpoint")
            .map(|(i, _)| i)
            .collect();
        assert_eq!(uses.len(), 2, "encode_send and endpoint_origin");
        for i in uses {
            let before = &alerts[i.saturating_sub(60)..i];
            assert!(
                before.contains("encode_send(") || before.contains("endpoint_origin("),
                "{before}"
            );
        }
        for field in ["sub.p256dh", "sub.auth"] {
            assert_eq!(
                alerts.matches(field).count(),
                1,
                "{field}: only in encode_send"
            );
        }
    }

    #[test]
    fn no_log_line_carries_a_person_a_subscription_a_place_or_a_key() {
        let alerts = code(JOBS_ALERTS);
        let calls: Vec<&str> = ["console_log!(", "console_error!(", "console_warn!("]
            .iter()
            .flat_map(|n| calls_of(&alerts, n))
            .collect();
        assert!(!calls.is_empty());
        for call in calls {
            let call = without_strings(call);
            for ident in [
                "sub",
                "person",
                "person_id",
                "send_key",
                "key",
                "wire",
                "planned",
                "place",
                "claim_body",
                "outcome_body",
                "body",
                "endpoint",
                "slug",
                "cell",
                "payload",
            ] {
                assert!(
                    !call
                        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
                        .any(|w| w == ident),
                    "a log call names `{ident}`: {call}"
                );
            }
        }
        assert_absent(&alerts, &["{:?}", "{:#?}", "dbg!", "println!"]);
        let lib = code(JOBS_LIB);
        assert_absent(&lib, &["{:?}"]);
    }

    #[test]
    fn the_tick_holds_no_vapid_key_and_calls_no_push_service() {
        let alerts = code(JOBS_ALERTS);
        assert_absent(
            &alerts,
            &[
                "VAPID",
                "fcm.googleapis",
                "push.services.mozilla",
                "Fetch::",
                "WebCrypto",
                "weather_webpush",
            ],
        );
        let manifest = code(JOBS_MANIFEST);
        assert_absent(&manifest, &["weather-webpush"]);
    }

    #[test]
    fn wrangler_binds_the_sender_by_service_and_holds_the_two_keys_it_needs() {
        let config = code(JOBS_WRANGLER);
        assert_present(
            &config,
            &[
                "\"binding\": \"PUSH\"",
                "\"service\": \"mukoko-weather-push\"",
                "\"10 * * * *\"",
            ],
        );
        assert_eq!(
            literals_after(&config, "\"secret_name\": \""),
            [
                "MUKOKO_WEATHER_PUSH_SEND_KEY",
                "MUKOKO_WEATHER_ALERT_SENDER_KEY"
            ]
        );
        assert_absent(&config, &["\"routes\"", "\"custom_domain\"", "VAPID"]);
    }
}

/// The deploy: `push` is in the order, before `jobs` (whose `PUSH` binding
/// names it), and after the Workers it binds to (none).
mod deploy {
    use super::*;

    fn order() -> Vec<&'static str> {
        DEPLOY
            .lines()
            .find(|l| l.trim_start().starts_with("order=("))
            .expect("the deploy order")
            .trim()
            .trim_start_matches("order=(")
            .trim_end_matches(')')
            .split_whitespace()
            .collect()
    }

    #[test]
    fn ci_builds_both_workers() {
        let matrix = CI
            .lines()
            .find(|l| l.contains("worker: ["))
            .expect("the build matrix");
        for w in ["push", "jobs"] {
            assert!(
                matrix.split([' ', ',', '[', ']']).any(|m| m == w),
                "workers.yml builds {w}: {matrix}"
            );
        }
    }

    #[test]
    fn push_deploys_before_jobs() {
        let order = order();
        let at = |w: &str| {
            order
                .iter()
                .position(|o| *o == w)
                .unwrap_or_else(|| panic!("{w} is not in the deploy order: {order:?}"))
        };
        assert!(at("push") < at("jobs"), "{order:?}");
        // Nothing that does not need the sender waits behind it: a failed
        // `push` deploy (a missing store secret) must not stop `public-api`.
        assert!(at("public-api") < at("push"), "{order:?}");
        assert!(at("forecast") < at("jobs"));
    }

    #[test]
    fn push_is_a_choice_of_the_manual_deploy() {
        assert!(
            DEPLOY.lines().any(|l| l.trim() == "- push"),
            "push is a choice of the manual deploy"
        );
    }

    #[test]
    fn a_missing_secret_fails_the_deploy_loudly_and_nothing_skips_it() {
        // Both Workers declare store bindings; a binding to a secret that does
        // not exist fails `wrangler deploy` (10182). The workflow must not turn
        // that into a skip.
        assert!(code(WRANGLER).contains("\"secrets_store_secrets\""));
        assert!(code(JOBS_WRANGLER).contains("\"secrets_store_secrets\""));
        assert!(DEPLOY.contains("set -euo pipefail"));
        for banned in ["continue-on-error", "if: ${{ vars."] {
            assert!(
                !DEPLOY.contains(banned),
                "the deploy must not skip silently: {banned}"
            );
        }
    }
}
