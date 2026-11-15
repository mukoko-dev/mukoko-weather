//! `mukoko-weather-web`: serves the Astro static build and routes the web app
//! (mukoko-dev/mukoko-weather#579, #475).
//!
//! Owner decision: "Rust serves it, JS only in the browser". `astro build`
//! writes plain files; this Worker is the only server. It reads them through
//! the `ASSETS` binding (with `run_worker_first`, so every request comes here
//! first) and decides everything else in `weather_core::web`, which is pure and
//! tested natively: which file a path means, the headers, the cache rules, what
//! an un-migrated route answers. This file is the glue: it fetches the file and
//! applies the answer.
//!
//! ```text
//! GET /about            -> astro/dist/about.html   no-cache, security headers
//! GET /_astro/x.<hash>.js -> the file               public, max-age=31536000, immutable
//! GET /about/           -> 308 /about
//! GET /harare           -> 404 problem+json (not migrated)   or, with LEGACY_ORIGIN, the Next.js app
//! GET /health, /ready   -> probes
//! ```
//!
//! DARK: nothing routes to it yet (`wrangler.jsonc` has no routes) and it is
//! not in `workers-deploy.yml`. It has not run in a Workers runtime; the
//! decisions are unit tested and the glue is checked only by compiling for
//! `wasm32-unknown-unknown`.

use std::sync::{Once, OnceLock};
use std::time::Duration;

use futures::future::{select, Either};
use serde_json::json;
use weather_core::web::{
    self, cache,
    headers::{self, parse_bare_origin},
    plan::MAX_PROXY_BODY,
    problem, AssetClass, Config, Plan, Problem, Req, RouteTable,
};
use worker::{
    console_error, event, AbortController, Context, Delay, Env, Fetch, Headers, Method, Request,
    RequestInit, RequestRedirect, Response, Result,
};

const ROUTES_JSON: &str = include_str!("../routing/routes.json");
const ASSETS: &str = "ASSETS";
const LEGACY_TIMEOUT: Duration = Duration::from_secs(10);

/// The route table, parsed once per isolate. A table that does not parse is a
/// build error caught by the tests; if it ever reached here, every request
/// would answer a `500` problem rather than a wrong page.
static ROUTES: OnceLock<std::result::Result<RouteTable, String>> = OnceLock::new();
static PANIC_HOOK: Once = Once::new();

#[event(fetch)]
pub async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    // A panic is a bug, and a trap in WebAssembly: the platform answers 500 and
    // the next request gets a fresh instance. The hook puts the reason in the
    // log first (never a header or a body).
    PANIC_HOOK.call_once(|| {
        std::panic::set_hook(Box::new(|info| console_error!("web: panic: {info}")));
    });
    let path = req.path();
    match handle(req, &env).await {
        Ok(resp) => Ok(resp),
        Err(e) => {
            console_error!("web: {e}");
            problem_response(&Problem::internal(), &path, &[], None)
        }
    }
}

/// The request's path, query and method, as plain values.
struct Call {
    method: String,
    path: String,
    query: String,
    host: String,
    content_length: Option<u64>,
    /// The request headers that make a revalidation (`304`), a range or a
    /// compressed answer work when the file is read from the assets: nothing
    /// else of the visitor's request is passed on.
    forward: Vec<(String, String)>,
}

const FORWARDED_TO_ASSETS: [&str; 5] = [
    "If-None-Match",
    "If-Modified-Since",
    "Accept-Encoding",
    "Range",
    "If-Range",
];

async fn handle(req: Request, env: &Env) -> Result<Response> {
    let url = req.url()?;
    let call = Call {
        method: req.method().to_string(),
        path: url.path().to_owned(),
        query: url.query().map(|q| format!("?{q}")).unwrap_or_default(),
        host: url.host_str().unwrap_or_default().to_owned(),
        content_length: req
            .headers()
            .get("Content-Length")?
            .and_then(|v| v.trim().parse().ok()),
        forward: FORWARDED_TO_ASSETS
            .iter()
            .filter_map(|name| {
                req.headers()
                    .get(name)
                    .ok()
                    .flatten()
                    .map(|v| ((*name).to_owned(), v))
            })
            .collect(),
    };

    let routes = match ROUTES.get_or_init(|| RouteTable::parse(ROUTES_JSON)) {
        Ok(t) => t,
        Err(e) => {
            console_error!("web: {e}");
            return problem_response(&Problem::internal(), &call.path, &[], None);
        }
    };
    let legacy_origin =
        weather_edge::config(env, "LEGACY_ORIGIN").and_then(|v| parse_bare_origin(v.trim()));
    // The deployment's API origin, for the CSP's connect-src (what
    // `couchApiConnectSrc` does for the Next.js app).
    let extra_connect: Vec<String> = weather_edge::config(env, "NYUCHI_API_URL")
        .and_then(|v| parse_bare_origin(v.trim()))
        .into_iter()
        .collect();
    let config = Config {
        routes,
        legacy_origin,
    };
    let decision_req = Req {
        method: &call.method,
        path: &call.path,
        content_length: call.content_length,
    };

    match web::plan(&decision_req, &config) {
        Plan::Health => probe(
            200,
            &json!({"service": "mukoko-weather-web", "status": "ok"}),
            &call,
            &extra_connect,
        ),
        Plan::Ready => ready(env, &config, &call, &extra_connect).await,
        Plan::Preflight { allow } => {
            let mut resp = bare(204, &call.path, &extra_connect)?;
            resp.headers_mut().set("Allow", allow)?;
            tag(resp, "options")
        }
        Plan::Redirect { to } => {
            let resp = bare(308, &call.path, &extra_connect)?;
            resp.headers()
                .set("Location", &format!("{to}{}", call.query))?;
            resp.headers()
                .set("Cache-Control", cache::REDIRECT_CACHE_CONTROL)?;
            tag(resp, "redirect")
        }
        Plan::Problem { problem, allow } => {
            problem_response(&problem, &call.path, &extra_connect, allow)
        }
        Plan::Asset { path, class } => {
            match serve_asset(env, &call, &path, class, &extra_connect).await? {
                Some(resp) => Ok(resp),
                None => match web::asset_miss(&decision_req, &config) {
                    Plan::Proxy { origin } => proxy(req, &origin, &call).await,
                    Plan::Problem { problem, allow } => {
                        problem_response(&problem, &call.path, &extra_connect, allow)
                    }
                    _ => problem_response(&Problem::not_found(), &call.path, &extra_connect, None),
                },
            }
        }
        Plan::Proxy { origin } => proxy(req, &origin, &call).await,
    }
}

/// A response with the security headers for `path` and no body.
fn bare(status: u16, path: &str, extra_connect: &[String]) -> Result<Response> {
    let resp = Response::empty()?.with_status(status);
    for (k, v) in headers::security(path, extra_connect) {
        resp.headers().set(k, &v)?;
    }
    Ok(resp)
}

/// Mark which branch answered, for a person reading a response with curl.
fn tag(resp: Response, route: &str) -> Result<Response> {
    resp.headers().set("X-Mukoko-Route", route)?;
    Ok(resp)
}

fn problem_response(
    p: &Problem,
    path: &str,
    extra_connect: &[String],
    allow: Option<&'static str>,
) -> Result<Response> {
    let resp = Response::from_bytes(p.to_json(path).into_bytes())?.with_status(p.status);
    for (k, v) in headers::security(path, extra_connect) {
        resp.headers().set(k, &v)?;
    }
    resp.headers().set("Content-Type", problem::CONTENT_TYPE)?;
    resp.headers()
        .set("Cache-Control", cache::PROBLEM_CACHE_CONTROL)?;
    if let Some(allow) = allow {
        resp.headers().set("Allow", allow)?;
    }
    tag(resp, "problem")
}

fn probe(
    status: u16,
    body: &serde_json::Value,
    call: &Call,
    extra_connect: &[String],
) -> Result<Response> {
    let resp = Response::from_bytes(body.to_string().into_bytes())?.with_status(status);
    for (k, v) in headers::security(&call.path, extra_connect) {
        resp.headers().set(k, &v)?;
    }
    resp.headers().set("Content-Type", "application/json")?;
    resp.headers()
        .set("Cache-Control", cache::PROBE_CACHE_CONTROL)?;
    tag(resp, "probe")
}

/// `/ready`: the one dependency is the static assets. Ready means the binding
/// is there and answers for the first migrated page.
async fn ready(
    env: &Env,
    config: &Config<'_>,
    call: &Call,
    extra_connect: &[String],
) -> Result<Response> {
    let Some(file) = config.routes.assets().first().map(|a| (*a).to_owned()) else {
        return problem_response(
            &Problem::unavailable("The route table lists no page."),
            &call.path,
            extra_connect,
            None,
        );
    };
    let up = match env.assets(ASSETS) {
        Ok(assets) => {
            let mut init = RequestInit::new();
            init.with_method(Method::Head);
            match assets
                .fetch(format!("https://assets.invalid/{file}"), Some(init))
                .await
            {
                Ok(r) => r.status_code() == 200,
                Err(_) => false,
            }
        }
        Err(_) => false,
    };
    if up {
        probe(
            200,
            &json!({"service": "mukoko-weather-web", "status": "ready", "assets": "ok"}),
            call,
            extra_connect,
        )
    } else {
        problem_response(
            &Problem::unavailable("The static assets are not available."),
            &call.path,
            extra_connect,
            None,
        )
    }
}

/// Read `file` from the assets and answer it with our headers. `None` when the
/// assets have no such file.
async fn serve_asset(
    env: &Env,
    call: &Call,
    file: &str,
    class: AssetClass,
    extra_connect: &[String],
) -> Result<Option<Response>> {
    let assets = env.assets(ASSETS)?;
    let mut init = RequestInit::new();
    init.with_method(if call.method.eq_ignore_ascii_case("HEAD") {
        Method::Head
    } else {
        Method::Get
    });
    init.with_headers(call_headers(call)?);
    let resp = assets
        .fetch(format!("https://{}/{file}", call.host), Some(init))
        .await?;
    if resp.status_code() == 404 {
        return Ok(None);
    }
    let mut extra = headers::security(&call.path, extra_connect);
    extra.push(("Cache-Control", cache::cache_control(class).to_owned()));
    if let Some(ct) = cache::content_type(class) {
        extra.push(("Content-Type", ct.to_owned()));
    }
    if let Some(allowed) = cache::service_worker_allowed(class) {
        extra.push(("Service-Worker-Allowed", allowed.to_owned()));
    }
    extra.push(("X-Mukoko-Route", "asset".to_owned()));
    // An error from the assets (not a file, not a 304) keeps its status but is
    // never cached as a page.
    if !(200..400).contains(&resp.status_code()) {
        extra.retain(|(k, _)| *k != "Cache-Control");
        extra.push(("Cache-Control", cache::PROBLEM_CACHE_CONTROL.to_owned()));
    }
    Ok(Some(rebuild(resp, &extra)?))
}

/// The conditional and encoding headers of the visitor's request, which the
/// assets binding needs to answer `304` and to compress.
fn call_headers(call: &Call) -> Result<Headers> {
    let headers = Headers::new();
    for (k, v) in &call.forward {
        headers.set(k, v)?;
    }
    Ok(headers)
}

/// The same response with `extra` set on its headers. A fetched response's
/// headers are immutable, so this builds a new one over the same body.
fn rebuild(resp: Response, extra: &[(&str, String)]) -> Result<Response> {
    let headers = Headers::new();
    for (k, v) in resp.headers().entries() {
        headers.set(&k, &v)?;
    }
    for (k, v) in extra {
        headers.set(k, v)?;
    }
    let (builder, body) = resp.into_parts();
    Ok(builder.with_headers(headers).body(body))
}

/// Forward to the legacy origin (`LEGACY_ORIGIN`), the stopgap for routes that
/// are not migrated. One redirect is never followed on the visitor's behalf,
/// the body is bounded, and the call has a timeout.
async fn proxy(mut req: Request, origin: &str, call: &Call) -> Result<Response> {
    let target = format!("{origin}{}{}", call.path, call.query);
    let headers = Headers::new();
    for (k, v) in req.headers().entries() {
        let name = k.to_ascii_lowercase();
        let hop = matches!(
            name.as_str(),
            "host"
                | "connection"
                | "keep-alive"
                | "transfer-encoding"
                | "te"
                | "trailer"
                | "upgrade"
                | "content-length"
                | "x-forwarded-host"
        ) || name.starts_with("proxy-")
            || name.starts_with("cf-");
        if !hop {
            headers.set(&k, &v)?;
        }
    }
    headers.set("X-Forwarded-Host", &call.host)?;

    let mut init = RequestInit::new();
    init.with_method(req.method());
    init.with_headers(headers);
    init.with_redirect(RequestRedirect::Manual);
    if !matches!(call.method.to_ascii_uppercase().as_str(), "GET" | "HEAD") {
        let bytes = req.bytes().await?;
        if bytes.len() as u64 > MAX_PROXY_BODY {
            return problem_response(
                &Problem::payload_too_large(MAX_PROXY_BODY),
                &call.path,
                &[],
                None,
            );
        }
        let body = js_sys::Uint8Array::from(bytes.as_slice());
        init.with_body(Some(body.into()));
    }

    let outbound = Request::new_with_init(&target, &init)?;
    let controller = AbortController::default();
    let signal = controller.signal();
    let fetch = Fetch::Request(outbound);
    let call_future = Box::pin(fetch.send_with_signal(&signal));
    let timer = Box::pin(Delay::from(LEGACY_TIMEOUT));
    let outcome = select(call_future, timer).await;
    match outcome {
        Either::Left((Ok(resp), _)) => rebuild(resp, &[("X-Mukoko-Route", "legacy".to_owned())]),
        Either::Left((Err(e), _)) => {
            console_error!("web: legacy origin: {e}");
            problem_response(&Problem::bad_gateway(), &call.path, &[], None)
        }
        Either::Right(_) => {
            controller.abort();
            console_error!("web: legacy origin timed out");
            problem_response(&Problem::bad_gateway(), &call.path, &[], None)
        }
    }
}
