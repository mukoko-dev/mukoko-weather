//! The Workers' secrets: Cloudflare Secrets Store first, plain wrangler
//! secret second.
//!
//! Each key is ONE secret in the account's shared Secrets Store, bound by
//! every Worker that needs it (the Tomorrow.io key by forecast and tiles,
//! the Nyuchi API key by forecast, places and ai): no per-Worker copies.
//! The store names carry `MUKOKO_WEATHER_` because each of these keys is
//! this app's own (see `ALL`), so they cannot collide with another app's
//! secret in the shared store. A Worker binds a secret as a
//! `secrets_store_secrets` binding named after the store secret; the
//! binding is an object whose async `get()` returns the value.
//!
//! The code asks for a secret by its plain name (`TOMORROW_API_KEY`), the
//! name the Workers have always used. The store binding cannot reuse that
//! name while the plain secret still exists on the Worker: two bindings may
//! not share a name, so a deploy would be refused until the plain secret was
//! deleted, and there would be nothing to fall back to.
//!
//! TRANSITION (remove once every secret is confirmed in the store): when the
//! store binding is missing, the secret is not in the store, or the read
//! fails, the plain wrangler secret of the plain name is used instead, with
//! a warning logged once per isolate per secret (the name and the reason,
//! never the value). Removing the fallback means deleting the `plain`
//! argument below, `Fallback`, and the plain secrets on the Workers
//! (`wrangler secret delete <NAME>`).
//!
//! A store value is kept for the life of the isolate once read: a store read
//! is a round trip. A fallback value is not kept, so a secret added to the
//! store is picked up on the next request without a redeploy. A rotated
//! store value is picked up when the isolate is recycled (or on the next
//! deploy).
//!
//! The lookups are plain closures, so this is tested natively with mocked
//! bindings; `weather-edge` wires them to the Worker `Env`.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::future::Future;

/// The account's Secrets Store (an id, not a credential).
pub const STORE_ID: &str = "56f84bfa8a564c54a95dbf4f4b4281b4";

/// Tomorrow.io API key (forecasts and map tiles).
pub const TOMORROW_API_KEY: &str = "TOMORROW_API_KEY";
/// Internal Nyuchi API key (places read, AI guardrails).
pub const NYUCHI_API_KEY: &str = "NYUCHI_API_KEY";
/// The bearer key first-party services present to mukoko-weather-internal.
pub const WEATHER_SERVICE_API_KEY: &str = "WEATHER_SERVICE_API_KEY";
/// CheckWX API key: the METAR fallback when the Aviation Weather Center fails.
pub const CHECKWX_API_KEY: &str = "CHECKWX_API_KEY";

/// A secret: its plain name (what the code asks for, and the transition
/// fallback), its one store secret name (also the binding name), and the
/// Workers (by directory under `workers/`) that bind it.
#[derive(Debug, Clone, Copy)]
pub struct SecretSpec {
    pub name: &'static str,
    pub store: &'static str,
    pub required: bool,
    pub workers: &'static [&'static str],
}

/// Every secret the Workers read.
pub const ALL: [SecretSpec; 4] = [
    SecretSpec {
        name: TOMORROW_API_KEY,
        store: "MUKOKO_WEATHER_TOMORROW_API_KEY",
        required: true,
        workers: &["forecast", "tiles"],
    },
    SecretSpec {
        name: NYUCHI_API_KEY,
        store: "MUKOKO_WEATHER_NYUCHI_API_KEY",
        required: true,
        workers: &["ai", "forecast", "places"],
    },
    SecretSpec {
        name: WEATHER_SERVICE_API_KEY,
        store: "MUKOKO_WEATHER_SERVICE_API_KEY",
        required: true,
        workers: &["internal-api"],
    },
    SecretSpec {
        name: CHECKWX_API_KEY,
        store: "MUKOKO_WEATHER_CHECKWX_API_KEY",
        required: false,
        workers: &["aviation"],
    },
];

/// The store secret name (also the binding name) for a plain name; `None`
/// for a name that is not a secret.
pub fn store_name(name: &str) -> Option<&'static str> {
    ALL.iter().find(|s| s.name == name).map(|s| s.store)
}

/// What reading a Secrets Store binding gave.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreRead {
    /// No binding of that name on the Worker.
    Unbound,
    /// Bound, but the store has no such secret (or it is blank).
    Missing,
    /// Bound, but `get()` failed.
    Failed,
    Value(String),
}

/// Why the plain secret was used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fallback {
    Unbound,
    Missing,
    Failed,
}

impl Fallback {
    pub fn reason(self) -> &'static str {
        match self {
            Fallback::Unbound => "no Secrets Store binding",
            Fallback::Missing => "secret not in the Secrets Store",
            Fallback::Failed => "Secrets Store read failed",
        }
    }
}

/// The answer to one lookup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lookup {
    pub value: Option<String>,
    /// Set the first time in this isolate that `name` fell back to the plain
    /// secret: the caller logs it, once.
    pub warn: Option<Fallback>,
}

/// Store values read so far in this isolate, and the fallbacks already warned about.
#[derive(Debug, Default)]
pub struct SecretCache {
    values: RefCell<HashMap<String, String>>,
    warned: RefCell<HashSet<String>>,
}

fn nonblank(v: String) -> Option<String> {
    (!v.trim().is_empty()).then_some(v)
}

impl SecretCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// The secret `name`: from the cache, else from `store`, else (for the
    /// transition) from `plain`. A blank value counts as missing.
    pub async fn get<S, SF, P>(&self, name: &str, store: S, plain: P) -> Lookup
    where
        S: FnOnce() -> SF,
        SF: Future<Output = StoreRead>,
        P: FnOnce() -> Option<String>,
    {
        if let Some(v) = self.values.borrow().get(name) {
            return Lookup {
                value: Some(v.clone()),
                warn: None,
            };
        }
        // No borrow is held across the await.
        let why = match store().await {
            StoreRead::Value(v) => match nonblank(v) {
                Some(v) => {
                    self.values.borrow_mut().insert(name.to_owned(), v.clone());
                    return Lookup {
                        value: Some(v),
                        warn: None,
                    };
                }
                None => Fallback::Missing,
            },
            StoreRead::Unbound => Fallback::Unbound,
            StoreRead::Missing => Fallback::Missing,
            StoreRead::Failed => Fallback::Failed,
        };
        let value = plain().and_then(nonblank);
        let warn =
            (value.is_some() && self.warned.borrow_mut().insert(name.to_owned())).then_some(why);
        Lookup { value, warn }
    }

    /// Whether a store value for `name` is kept.
    pub fn holds(&self, name: &str) -> bool {
        self.values.borrow().contains_key(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};

    /// A mocked Secrets Store binding: a fixed answer, counting its `get()`s.
    struct MockStore {
        read: RefCell<StoreRead>,
        gets: Cell<u32>,
    }

    impl MockStore {
        fn new(read: StoreRead) -> Self {
            Self {
                read: RefCell::new(read),
                gets: Cell::new(0),
            }
        }

        async fn get(&self) -> StoreRead {
            self.gets.set(self.gets.get() + 1);
            self.read.borrow().clone()
        }
    }

    /// A mocked plain wrangler secret.
    struct MockPlain {
        value: Option<String>,
        reads: Cell<u32>,
    }

    impl MockPlain {
        fn new(value: Option<&str>) -> Self {
            Self {
                value: value.map(str::to_owned),
                reads: Cell::new(0),
            }
        }

        fn get(&self) -> Option<String> {
            self.reads.set(self.reads.get() + 1);
            self.value.clone()
        }
    }

    /// Runs a future that never waits (the mocks resolve at once).
    fn block_on<F: Future>(f: F) -> F::Output {
        let mut f = pin!(f);
        let mut cx = Context::from_waker(Waker::noop());
        match f.as_mut().poll(&mut cx) {
            Poll::Ready(v) => v,
            Poll::Pending => panic!("the mocks never wait"),
        }
    }

    fn lookup(cache: &SecretCache, name: &str, store: &MockStore, plain: &MockPlain) -> Lookup {
        block_on(cache.get(name, || store.get(), || plain.get()))
    }

    #[test]
    fn a_store_hit_is_used_and_kept_for_the_isolate() {
        let cache = SecretCache::new();
        let store = MockStore::new(StoreRead::Value("tmrw_store".into()));
        let plain = MockPlain::new(Some("tmrw_plain"));
        for _ in 0..3 {
            let got = lookup(&cache, TOMORROW_API_KEY, &store, &plain);
            assert_eq!(got.value.as_deref(), Some("tmrw_store"));
            assert_eq!(got.warn, None);
        }
        assert_eq!(store.gets.get(), 1);
        assert_eq!(plain.reads.get(), 0, "the plain secret is never read");
        assert!(cache.holds(TOMORROW_API_KEY));
    }

    #[test]
    fn a_missing_binding_falls_back_to_the_plain_secret_and_warns_once() {
        let cache = SecretCache::new();
        let store = MockStore::new(StoreRead::Unbound);
        let plain = MockPlain::new(Some("nyk_plain"));
        let first = lookup(&cache, NYUCHI_API_KEY, &store, &plain);
        assert_eq!(first.value.as_deref(), Some("nyk_plain"));
        assert_eq!(first.warn, Some(Fallback::Unbound));
        let second = lookup(&cache, NYUCHI_API_KEY, &store, &plain);
        assert_eq!(second.value.as_deref(), Some("nyk_plain"));
        assert_eq!(second.warn, None, "warned once per isolate");
        assert!(!cache.holds(NYUCHI_API_KEY), "a fallback value is not kept");
    }

    #[test]
    fn a_secret_not_in_the_store_falls_back_until_it_is_added() {
        let cache = SecretCache::new();
        let store = MockStore::new(StoreRead::Missing);
        let plain = MockPlain::new(Some("svc_plain"));
        let got = lookup(&cache, WEATHER_SERVICE_API_KEY, &store, &plain);
        assert_eq!(got.value.as_deref(), Some("svc_plain"));
        assert_eq!(got.warn, Some(Fallback::Missing));
        // The owner adds it to the store: the next request uses it.
        *store.read.borrow_mut() = StoreRead::Value("svc_store".into());
        let got = lookup(&cache, WEATHER_SERVICE_API_KEY, &store, &plain);
        assert_eq!(got.value.as_deref(), Some("svc_store"));
        assert_eq!(got.warn, None);
        assert!(cache.holds(WEATHER_SERVICE_API_KEY));
    }

    #[test]
    fn a_failed_or_blank_store_read_falls_back() {
        let cache = SecretCache::new();
        let plain = MockPlain::new(Some("k"));
        let failed = MockStore::new(StoreRead::Failed);
        let got = lookup(&cache, TOMORROW_API_KEY, &failed, &plain);
        assert_eq!(
            (got.value.as_deref(), got.warn),
            (Some("k"), Some(Fallback::Failed))
        );
        let blank = MockStore::new(StoreRead::Value("  ".into()));
        let got = lookup(&cache, NYUCHI_API_KEY, &blank, &plain);
        assert_eq!(
            (got.value.as_deref(), got.warn),
            (Some("k"), Some(Fallback::Missing))
        );
    }

    #[test]
    fn an_optional_secret_absent_from_both_is_none_without_a_warning() {
        let cache = SecretCache::new();
        let plain = MockPlain::new(None);
        for read in [StoreRead::Unbound, StoreRead::Missing] {
            let store = MockStore::new(read);
            let got = lookup(&cache, CHECKWX_API_KEY, &store, &plain);
            assert_eq!(
                got,
                Lookup {
                    value: None,
                    warn: None
                }
            );
        }
        // A blank plain secret is absent too.
        let blank = MockPlain::new(Some(" "));
        let got = lookup(
            &cache,
            CHECKWX_API_KEY,
            &MockStore::new(StoreRead::Missing),
            &blank,
        );
        assert_eq!(got.value, None);
        assert!(!cache.holds(CHECKWX_API_KEY));
    }

    #[test]
    fn store_names_are_namespaced() {
        assert_eq!(
            store_name(TOMORROW_API_KEY),
            Some("MUKOKO_WEATHER_TOMORROW_API_KEY")
        );
        assert_eq!(
            store_name(WEATHER_SERVICE_API_KEY),
            Some("MUKOKO_WEATHER_SERVICE_API_KEY")
        );
        assert_eq!(store_name("NYUCHI_API_URL"), None);
        for (i, spec) in ALL.iter().enumerate() {
            assert!(spec.store.starts_with("MUKOKO_WEATHER_"), "{}", spec.name);
            // The binding can never collide with the plain fallback secret.
            assert_ne!(spec.store, spec.name);
            // One store secret per key.
            assert!(ALL[i + 1..].iter().all(|o| o.store != spec.store));
        }
    }

    fn wrangler(worker: &str) -> &'static str {
        match worker {
            "ai" => include_str!("../../../ai/wrangler.jsonc"),
            "aviation" => include_str!("../../../aviation/wrangler.jsonc"),
            "forecast" => include_str!("../../../forecast/wrangler.jsonc"),
            "internal-api" => include_str!("../../../internal-api/wrangler.jsonc"),
            "jobs" => include_str!("../../../jobs/wrangler.jsonc"),
            "places" => include_str!("../../../places/wrangler.jsonc"),
            "public-api" => include_str!("../../../public-api/wrangler.jsonc"),
            "stations" => include_str!("../../../stations/wrangler.jsonc"),
            "tiles" => include_str!("../../../tiles/wrangler.jsonc"),
            other => panic!("unknown Worker {other}"),
        }
    }

    const WORKERS: [&str; 9] = [
        "ai",
        "aviation",
        "forecast",
        "internal-api",
        "jobs",
        "places",
        "public-api",
        "stations",
        "tiles",
    ];

    #[test]
    fn each_worker_binds_exactly_the_secrets_it_reads() {
        for worker in WORKERS {
            let cfg = wrangler(worker);
            for spec in ALL {
                let store = spec.store;
                let binding = format!("\"binding\": \"{store}\"");
                let secret = format!("\"secret_name\": \"{store}\"");
                let want = usize::from(spec.workers.contains(&worker));
                assert_eq!(cfg.matches(&binding).count(), want, "{worker}: {store}");
                assert_eq!(cfg.matches(&secret).count(), want, "{worker}: {store}");
                // The plain name is never a binding: it is the fallback secret.
                let plain = format!("\"binding\": \"{}\"", spec.name);
                assert_eq!(cfg.matches(&plain).count(), 0, "{worker}: {}", spec.name);
            }
            let stores = cfg.matches("\"store_id\"").count();
            assert_eq!(
                stores,
                cfg.matches(&format!("\"store_id\": \"{STORE_ID}\""))
                    .count(),
                "{worker}: every binding uses the account store"
            );
            let bound = ALL.iter().filter(|s| s.workers.contains(&worker)).count();
            assert_eq!(stores, bound, "{worker}");
        }
    }
}
