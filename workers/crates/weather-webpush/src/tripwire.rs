//! Tripwires on `workers/push` (`mukoko-weather-push`), the Workers-runtime
//! half of the sender (mukoko-dev/mukoko-weather#289, step c).
//!
//! That crate wraps `crypto.subtle` and `fetch`, so it cannot run natively.
//! These tests read its source and its `wrangler.jsonc`: a tripwire that the
//! glue uses the pure rules in [`crate::runtime`] and keeps to the limits set
//! out in its module docs, and that the Worker stays DARK. They are not
//! behaviour tests (the first real send, which is the owner's gate, is the
//! first run against a push service); they stop the easy mistakes: following
//! a redirect, reading the answer's body, sending a header the rules do not
//! name, exporting a private key, logging an endpoint, adding a schedule or a
//! secret before the owner has decided to.
//!
//! Comment lines are ignored, so the glue can explain itself.
//!
//! **When the owner turns the sender on** (the VAPID key pair exists, the
//! evaluator is built), the PR that does it deletes the tests in `dark` that
//! it contradicts, in the open, instead of working around them.

const TRANSPORT: &str = include_str!("../../../push/src/transport.rs");
const WEBCRYPTO: &str = include_str!("../../../push/src/webcrypto.rs");
const WORKER: &str = include_str!("../../../push/src/lib.rs");
const WRANGLER: &str = include_str!("../../../push/wrangler.jsonc");
const PUSH_MANIFEST: &str = include_str!("../../../push/Cargo.toml");
const LOCKFILE: &str = include_str!("../../../Cargo.lock");
const CI: &str = include_str!("../../../../.github/workflows/workers.yml");
const DEPLOY: &str = include_str!("../../../../.github/workflows/workers-deploy.yml");

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

/// The Worker stays dark: one route, no schedule, no secret, no reach to
/// anything.
mod dark {
    use super::*;

    #[test]
    fn the_worker_has_one_fetch_handler_and_no_other_entry_point() {
        let code = code(WORKER);
        assert_eq!(code.matches("#[event(").count(), 1);
        assert!(code.contains("#[event(fetch)]"));
        assert_absent(&code, &["scheduled", "#[event(queue)]", "email", "tail"]);
    }

    #[test]
    fn the_only_route_is_health() {
        let code = code(WORKER);
        assert_eq!(
            literals_after(&code, "(\"/"),
            vec!["health".to_string(), "health".to_string()],
            "GET and the 405 for every other method"
        );
        assert!(!code.contains("\"/internal"));
        assert!(!code.contains("\"/v1"));
        assert!(!code.contains("\"/push"));
        assert!(!code.contains("\"/send"));
    }

    #[test]
    fn the_worker_reaches_nothing_and_reads_no_secret() {
        let code = code(WORKER);
        assert_absent(
            &code,
            &[
                "secret",
                "env.",
                ".var(",
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
            ],
        );
    }

    #[test]
    fn wrangler_has_no_schedule_no_secret_no_route_no_binding() {
        let config = code(WRANGLER);
        assert_absent(
            &config,
            &[
                "\"triggers\"",
                "\"crons\"",
                "\"secrets_store_secrets\"",
                "\"routes\"",
                "\"route\"",
                "\"services\"",
                "\"d1_databases\"",
                "\"kv_namespaces\"",
                "\"r2_buckets\"",
                "\"queues\"",
                "\"durable_objects\"",
                "\"vars\"",
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
            ],
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

    #[test]
    fn ci_builds_the_worker_and_the_deploy_does_not_list_it_yet() {
        let matrix = CI
            .lines()
            .find(|l| l.contains("worker: ["))
            .expect("the build matrix");
        assert!(
            matrix.split([' ', ',', '[', ']']).any(|w| w == "push"),
            "workers.yml builds push: {matrix}"
        );
        // The deploy is the owner's gate: `push` is in neither the order of
        // an `all` deploy nor the Worker choices until the VAPID secret exists.
        let order = DEPLOY
            .lines()
            .find(|l| l.trim_start().starts_with("order=("))
            .expect("the deploy order");
        assert!(
            !order.split([' ', '(', ')']).any(|w| w == "push"),
            "{order}"
        );
        assert!(
            !DEPLOY.lines().any(|l| l.trim() == "- push"),
            "push is not a choice of the manual deploy"
        );
    }
}
