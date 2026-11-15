//! The decisions of the Rust web Worker (`workers/web`), pure and tested
//! natively (mukoko-dev/mukoko-weather#579).
//!
//! Owner decision: "Rust serves it, JS only in the browser". Astro builds
//! static pages; the Worker serves them and routes everything. Which file a
//! path means, which headers a response carries, what an un-migrated route
//! answers: all of it is decided here, as functions of plain values, so the
//! Worker is glue that fetches the asset and applies the answer.
//!
//! - [`headers`]: the security headers, ported from `src/lib/security-headers.ts`
//!   as data (a test compares them to a snapshot generated from that file);
//! - [`cache`]: the cache rules by kind of file;
//! - [`routes`]: the route table (`workers/web/routing/routes.json`);
//! - [`plan`]: one request in, what to do out;
//! - [`problem`]: RFC 9457 problem documents.
//!
//! Nothing in this module may panic on a request: the lint below denies the
//! constructs that do, and a test feeds it hostile paths.
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)
)]

pub mod cache;
pub mod headers;
pub mod plan;
pub mod problem;
pub mod routes;

pub use cache::AssetClass;
pub use plan::{asset_miss, plan, Config, Plan, Req};
pub use problem::Problem;
pub use routes::RouteTable;
