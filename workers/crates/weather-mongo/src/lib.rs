//! A minimal, read-only MongoDB client for Cloudflare Workers.
//!
//! Workers cannot use the `mongodb` crate (no threads, no sockets in `std`),
//! and the Atlas Data API was shut down on 30 September 2025, so this speaks
//! the wire protocol itself: `OP_MSG` over an outbound TLS socket
//! (`worker::Socket`), SCRAM-SHA-256 authentication and a small BSON codec.
//!
//! Everything but the socket is pure and tested natively, including a scripted
//! in-memory server that runs the whole handshake and a SCRAM exchange:
//!
//! - [`bson`]: the codec and the ordered `Doc`;
//! - [`wire`]: `OP_MSG` framing;
//! - [`scram`]: SCRAM-SHA-256 (RFC 5802 / 7677);
//! - [`uri`]: the seed-list connection string (`mongodb://`, not `+srv`);
//! - [`conn`]: handshake, authentication, commands and the read-only helpers
//!   `find`, `find_one` and `aggregate` (no writes, and no `$out` / `$merge`);
//! - `edge` (wasm only): the socket, timeouts and per-isolate connection reuse.
//!
//! Reads are sent with read preference `secondaryPreferred`, so any member of
//! the replica set answers (the first seed host that responds is used).

pub mod bson;
pub mod conn;
pub mod scram;
pub mod uri;
pub mod wire;

#[cfg(target_arch = "wasm32")]
pub mod edge;

/// What can go wrong. Messages never carry the connection string, a password
/// or a document's content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The connection string is unusable.
    Uri(String),
    /// A socket failed or closed.
    Io(String),
    /// A timeout.
    Timeout(&'static str),
    /// A malformed BSON document.
    Bson(String),
    /// The server spoke out of turn or sent something unexpected.
    Protocol(String),
    /// Authentication failed.
    Auth(String),
    /// The server answered `ok: 0`.
    Server { code: i64, message: String },
    /// The caller asked for something the read-only client refuses.
    Refused(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Uri(m) => write!(f, "connection string: {m}"),
            Error::Io(m) => write!(f, "socket: {m}"),
            Error::Timeout(what) => write!(f, "timed out: {what}"),
            Error::Bson(m) => write!(f, "bson: {m}"),
            Error::Protocol(m) => write!(f, "protocol: {m}"),
            Error::Auth(m) => write!(f, "authentication: {m}"),
            Error::Server { code, message } => write!(f, "server error {code}: {message}"),
            Error::Refused(m) => write!(f, "refused: {m}"),
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;
