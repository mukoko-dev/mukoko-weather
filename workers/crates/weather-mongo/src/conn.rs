//! One authenticated connection and the read-only commands.
//!
//! [`Connection`] is generic over a byte transport ([`Io`]): the Worker's
//! TLS socket in production (`edge`), a scripted in-memory server in the
//! tests, so the whole handshake, the SCRAM exchange and the cursor handling
//! run natively.
//!
//! The helpers are read-only on purpose: `find`, `find_one` and `aggregate`
//! (which refuses `$out` and `$merge`). They send read preference
//! `secondaryPreferred` and a server-side time limit, cap the number of
//! documents returned, and validate database and collection names.

use std::collections::HashMap;
use std::future::Future;

use serde_json::Value;
use subtle::ConstantTimeEq;

use crate::bson::{Bson, Doc};
use crate::scram;
use crate::uri::Uri;
use crate::wire;
use crate::{Error, Result};

/// A byte transport.
pub trait Io {
    fn write_all(&mut self, buf: &[u8]) -> impl Future<Output = Result<()>>;
    /// Exactly `n` bytes, or an error if the peer closes first.
    fn read_exact(&mut self, n: usize) -> impl Future<Output = Result<Vec<u8>>>;
}

/// Most documents `find` returns, whatever the caller asks.
pub const MAX_FIND_DOCS: usize = 1_000;
/// Most documents `aggregate` collects across all its batches.
pub const MAX_AGGREGATE_DOCS: usize = 5_000;
/// The server stops a command after this long.
const MAX_TIME_MS: i32 = 8_000;
const BATCH: i32 = 1_000;

/// (user, salt, iterations).
type SaltKey = (String, Vec<u8>, u32);

/// PBKDF2 results kept per isolate, so a reconnect does not pay 4096
/// iterations again. The entry is keyed by user, salt and iterations and
/// remembers the password it was derived from: a different password under the
/// same key (a rotated secret) is compared in constant time, misses, and is
/// recomputed. The password is never hashed to build a key.
#[derive(Default)]
pub struct SaltCache(HashMap<SaltKey, (Vec<u8>, [u8; 32])>);

impl SaltCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn get_or_compute(
        &mut self,
        user: &str,
        password: &str,
        salt: &[u8],
        iterations: u32,
    ) -> Result<[u8; 32]> {
        let key = (user.to_owned(), salt.to_vec(), iterations);
        if let Some((derived_for, v)) = self.0.get(&key) {
            if derived_for.len() == password.len()
                && bool::from(derived_for.as_slice().ct_eq(password.as_bytes()))
            {
                return Ok(*v);
            }
        }
        let v = scram::salted_password(password, salt, iterations)?;
        if self.0.len() > 8 {
            self.0.clear();
        }
        self.0.insert(key, (password.as_bytes().to_vec(), v));
        Ok(v)
    }
}

/// What `hello` says about the member we reached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hello {
    pub primary: bool,
    pub secondary: bool,
    pub max_wire_version: i64,
}

pub fn get<'a>(d: &'a Doc, key: &str) -> Option<&'a Bson> {
    d.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

fn as_i64(v: &Bson) -> Option<i64> {
    match v {
        Bson::Int32(i) => Some(i64::from(*i)),
        Bson::Int64(i) => Some(*i),
        Bson::Double(f) if f.fract() == 0.0 => Some(*f as i64),
        _ => None,
    }
}

fn name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

pub struct Connection<T: Io> {
    io: T,
    next_id: i32,
}

impl<T: Io> Connection<T> {
    pub fn new(io: T) -> Self {
        Connection { io, next_id: 1 }
    }

    /// Run one command on database `db` and return the reply, or the
    /// server's error.
    pub async fn command(&mut self, db: &str, mut cmd: Doc) -> Result<Doc> {
        cmd.push(("$db".into(), Bson::str(db)));
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1).max(1);
        let frame = wire::encode_request(id, &cmd)?;
        self.io.write_all(&frame).await?;
        let header: [u8; 16] = self
            .io
            .read_exact(16)
            .await?
            .try_into()
            .map_err(|_| Error::Protocol("short header".into()))?;
        let len = wire::message_length(&header)?;
        if wire::response_to(&header) != id {
            return Err(Error::Protocol("a reply to another request".into()));
        }
        let rest = self.io.read_exact(len - 16).await?;
        let reply = wire::decode_reply(&rest)?;
        match get(&reply, "ok").and_then(as_i64) {
            Some(1) => Ok(reply),
            _ => {
                let code = get(&reply, "code").and_then(as_i64).unwrap_or(0);
                let message = match get(&reply, "errmsg") {
                    Some(Bson::Str(s)) => s.clone(),
                    _ => "the command failed".to_owned(),
                };
                Err(Error::Server { code, message })
            }
        }
    }

    pub async fn hello(&mut self) -> Result<Hello> {
        let r = self
            .command(
                "admin",
                vec![
                    ("hello".into(), Bson::Int32(1)),
                    ("helloOk".into(), Bson::Bool(true)),
                    (
                        "client".into(),
                        Bson::doc([(
                            "driver",
                            Bson::doc([
                                ("name", Bson::str("mukoko-weather-edge")),
                                ("version", Bson::str("0.1")),
                            ]),
                        )]),
                    ),
                ],
            )
            .await?;
        let flag = |k: &str| matches!(get(&r, k), Some(Bson::Bool(true)));
        Ok(Hello {
            primary: flag("isWritablePrimary"),
            secondary: flag("secondary"),
            max_wire_version: get(&r, "maxWireVersion").and_then(as_i64).unwrap_or(0),
        })
    }

    fn payload(r: &Doc) -> Result<String> {
        match get(r, "payload") {
            Some(Bson::Binary(b)) => String::from_utf8(b.clone())
                .map_err(|_| Error::Auth("the server's payload is not text".into())),
            _ => Err(Error::Auth("the server sent no SCRAM payload".into())),
        }
    }

    /// SCRAM-SHA-256 against `uri.auth_source`. `nonce` must be random and
    /// printable (no commas); the caller supplies it so this stays pure.
    pub async fn authenticate(
        &mut self,
        uri: &Uri,
        nonce: &str,
        cache: &mut SaltCache,
    ) -> Result<()> {
        let (first, bare) = scram::client_first(&uri.user, nonce);
        let start = self
            .command(
                &uri.auth_source,
                vec![
                    ("saslStart".into(), Bson::Int32(1)),
                    ("mechanism".into(), Bson::str("SCRAM-SHA-256")),
                    ("payload".into(), Bson::Binary(first.into_bytes())),
                    ("autoAuthorize".into(), Bson::Int32(1)),
                    (
                        "options".into(),
                        Bson::doc([("skipEmptyExchange", Bson::Bool(true))]),
                    ),
                ],
            )
            .await
            .map_err(auth_error)?;
        let conversation = get(&start, "conversationId")
            .cloned()
            .ok_or_else(|| Error::Auth("no conversation id".into()))?;
        let server_first = Self::payload(&start)?;
        let sf = scram::parse_server_first(&server_first, nonce)?;
        let salted = cache.get_or_compute(&uri.user, &uri.password, &sf.salt, sf.iterations)?;
        let (final_msg, expected) = scram::client_final(&salted, &bare, &server_first, &sf.nonce);
        let mut reply = self
            .command(
                &uri.auth_source,
                vec![
                    ("saslContinue".into(), Bson::Int32(1)),
                    ("conversationId".into(), conversation.clone()),
                    ("payload".into(), Bson::Binary(final_msg.into_bytes())),
                ],
            )
            .await
            .map_err(auth_error)?;
        scram::verify_server_final(&Self::payload(&reply)?, &expected)?;
        // With skipEmptyExchange the server is done here; an older one wants
        // one empty acknowledgement.
        for _ in 0..2 {
            if matches!(get(&reply, "done"), Some(Bson::Bool(true))) {
                return Ok(());
            }
            reply = self
                .command(
                    &uri.auth_source,
                    vec![
                        ("saslContinue".into(), Bson::Int32(1)),
                        ("conversationId".into(), conversation.clone()),
                        ("payload".into(), Bson::Binary(Vec::new())),
                    ],
                )
                .await
                .map_err(auth_error)?;
        }
        if matches!(get(&reply, "done"), Some(Bson::Bool(true))) {
            Ok(())
        } else {
            Err(Error::Auth("the exchange did not finish".into()))
        }
    }

    /// `ping`, for a health check.
    pub async fn ping(&mut self, db: &str) -> Result<()> {
        self.command(db, vec![("ping".into(), Bson::Int32(1))])
            .await
            .map(|_| ())
    }

    fn read_pref() -> (String, Bson) {
        (
            "$readPreference".into(),
            Bson::doc([("mode", Bson::str("secondaryPreferred"))]),
        )
    }

    /// Documents matching `filter`, at most `opts.limit` (capped at
    /// [`MAX_FIND_DOCS`]).
    pub async fn find(&mut self, db: &str, coll: &str, opts: &FindOptions) -> Result<Vec<Value>> {
        if !name_ok(db) || !name_ok(coll) {
            return Err(Error::Refused("bad database or collection name".into()));
        }
        let limit = if opts.limit == 0 {
            MAX_FIND_DOCS
        } else {
            opts.limit.min(MAX_FIND_DOCS)
        };
        let mut cmd: Doc = vec![
            ("find".into(), Bson::str(coll)),
            ("filter".into(), Bson::from_json(&opts.filter)?),
        ];
        if let Some(p) = &opts.projection {
            cmd.push(("projection".into(), Bson::from_json(p)?));
        }
        if !opts.sort.is_empty() {
            cmd.push((
                "sort".into(),
                Bson::Doc(
                    opts.sort
                        .iter()
                        .map(|(k, dir)| (k.clone(), Bson::Int32(*dir)))
                        .collect(),
                ),
            ));
        }
        if opts.skip > 0 {
            cmd.push(("skip".into(), Bson::Int64(opts.skip as i64)));
        }
        cmd.push(("limit".into(), Bson::Int64(limit as i64)));
        cmd.push(("batchSize".into(), Bson::Int32(limit as i32)));
        cmd.push(("singleBatch".into(), Bson::Bool(true)));
        cmd.push(("maxTimeMS".into(), Bson::Int32(MAX_TIME_MS)));
        cmd.push(Self::read_pref());
        let reply = self.command(db, cmd).await?;
        batch(&reply, "firstBatch")
    }

    pub async fn find_one(&mut self, db: &str, coll: &str, filter: Value) -> Result<Option<Value>> {
        let opts = FindOptions {
            filter,
            limit: 1,
            ..FindOptions::default()
        };
        Ok(self.find(db, coll, &opts).await?.into_iter().next())
    }

    /// An aggregation pipeline's results (at most [`MAX_AGGREGATE_DOCS`]; more
    /// is an error, not a silent cut). `$out` and `$merge` are refused.
    pub async fn aggregate(
        &mut self,
        db: &str,
        coll: &str,
        pipeline: &[Value],
    ) -> Result<Vec<Value>> {
        if !name_ok(db) || !name_ok(coll) {
            return Err(Error::Refused("bad database or collection name".into()));
        }
        for stage in pipeline {
            let writes = stage
                .as_object()
                .is_some_and(|o| o.contains_key("$out") || o.contains_key("$merge"));
            if writes {
                return Err(Error::Refused("this client is read-only".into()));
            }
        }
        let cmd: Doc = vec![
            ("aggregate".into(), Bson::str(coll)),
            (
                "pipeline".into(),
                Bson::Array(
                    pipeline
                        .iter()
                        .map(Bson::from_json)
                        .collect::<Result<Vec<_>>>()?,
                ),
            ),
            (
                "cursor".into(),
                Bson::doc([("batchSize", Bson::Int32(BATCH))]),
            ),
            ("maxTimeMS".into(), Bson::Int32(MAX_TIME_MS)),
            Self::read_pref(),
        ];
        let mut reply = self.command(db, cmd).await?;
        let mut out = batch(&reply, "firstBatch")?;
        loop {
            let id = cursor_id(&reply);
            if id == 0 {
                return Ok(out);
            }
            if out.len() >= MAX_AGGREGATE_DOCS {
                // Release the server-side cursor, then refuse.
                let _ = self
                    .command(
                        db,
                        vec![
                            ("killCursors".into(), Bson::str(coll)),
                            ("cursors".into(), Bson::Array(vec![Bson::Int64(id)])),
                        ],
                    )
                    .await;
                return Err(Error::Refused(
                    "the aggregation returned too many documents".into(),
                ));
            }
            reply = self
                .command(
                    db,
                    vec![
                        ("getMore".into(), Bson::Int64(id)),
                        ("collection".into(), Bson::str(coll)),
                        ("batchSize".into(), Bson::Int32(BATCH)),
                        ("maxTimeMS".into(), Bson::Int32(MAX_TIME_MS)),
                    ],
                )
                .await?;
            out.extend(batch(&reply, "nextBatch")?);
        }
    }
}

/// What `find` takes.
#[derive(Debug, Clone, Default)]
pub struct FindOptions {
    pub filter: Value,
    pub projection: Option<Value>,
    /// `(field, 1 | -1)` in order.
    pub sort: Vec<(String, i32)>,
    pub skip: usize,
    /// 0 means [`MAX_FIND_DOCS`].
    pub limit: usize,
}

fn cursor_id(reply: &Doc) -> i64 {
    match get(reply, "cursor") {
        Some(Bson::Doc(c)) => get(c, "id").and_then(as_i64).unwrap_or(0),
        _ => 0,
    }
}

fn batch(reply: &Doc, key: &str) -> Result<Vec<Value>> {
    match get(reply, "cursor") {
        Some(Bson::Doc(c)) => match get(c, key) {
            Some(Bson::Array(a)) => Ok(a.iter().map(Bson::to_json).collect()),
            _ => Err(Error::Protocol(format!("the cursor has no {key}"))),
        },
        _ => Err(Error::Protocol("the reply has no cursor".into())),
    }
}

/// A refused login is an authentication error, not a generic server one.
fn auth_error(e: Error) -> Error {
    match e {
        Error::Server { code, .. } if code == 18 || code == 13 => {
            Error::Auth("the user or password was refused".into())
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bson;
    use futures::executor::block_on;
    use std::cell::RefCell;
    use std::rc::Rc;

    /// A scripted server: each request frame goes to `handler`, which returns
    /// the reply document; replies queue up for `read_exact`.
    struct Mock {
        out: Vec<u8>,
        queue: Vec<u8>,
        seen: Rc<RefCell<Vec<Doc>>>,
        handler: Box<dyn FnMut(&Doc) -> Doc>,
        /// Answer with this `responseTo` instead of the request id.
        wrong_response_to: bool,
    }

    impl Mock {
        fn new(handler: impl FnMut(&Doc) -> Doc + 'static) -> (Self, Rc<RefCell<Vec<Doc>>>) {
            let seen = Rc::new(RefCell::new(Vec::new()));
            (
                Mock {
                    out: Vec::new(),
                    queue: Vec::new(),
                    seen: seen.clone(),
                    handler: Box::new(handler),
                    wrong_response_to: false,
                },
                seen,
            )
        }
    }

    impl Io for Mock {
        async fn write_all(&mut self, buf: &[u8]) -> Result<()> {
            self.out.extend_from_slice(buf);
            let len = i32::from_le_bytes(self.out[0..4].try_into().unwrap()) as usize;
            assert_eq!(self.out.len(), len, "one whole request per write");
            let id = i32::from_le_bytes(self.out[4..8].try_into().unwrap());
            let doc = bson::decode(&self.out[21..]).unwrap();
            self.out.clear();
            self.seen.borrow_mut().push(doc.clone());
            let reply = (self.handler)(&doc);
            let to = if self.wrong_response_to { id + 1 } else { id };
            self.queue.extend(wire::encode_reply(to, &reply).unwrap());
            Ok(())
        }

        async fn read_exact(&mut self, n: usize) -> Result<Vec<u8>> {
            if self.queue.len() < n {
                return Err(Error::Io("closed".into()));
            }
            Ok(self.queue.drain(..n).collect())
        }
    }

    fn ok() -> Doc {
        vec![("ok".into(), Bson::Double(1.0))]
    }

    fn with(mut d: Doc, k: &str, v: Bson) -> Doc {
        d.push((k.into(), v));
        d
    }

    fn cursor(id: i64, key: &str, docs: Vec<Bson>) -> Doc {
        with(
            ok(),
            "cursor",
            Bson::doc([
                ("id", Bson::Int64(id)),
                ("ns", Bson::str("weather.x")),
                (key, Bson::Array(docs)),
            ]),
        )
    }

    fn name(d: &Doc) -> String {
        d[0].0.clone()
    }

    #[test]
    fn a_command_carries_its_name_first_and_the_database_last() {
        let (mock, seen) = Mock::new(|_| ok());
        let mut c = Connection::new(mock);
        block_on(c.ping("weather")).unwrap();
        let sent = seen.borrow();
        assert_eq!(name(&sent[0]), "ping");
        assert_eq!(
            sent[0].last().unwrap(),
            &("$db".to_owned(), Bson::str("weather"))
        );
    }

    #[test]
    fn hello_reads_the_member_role() {
        let (mock, _) = Mock::new(|_| {
            let mut d = ok();
            d.push(("isWritablePrimary".into(), Bson::Bool(false)));
            d.push(("secondary".into(), Bson::Bool(true)));
            d.push(("maxWireVersion".into(), Bson::Int32(21)));
            d
        });
        let mut c = Connection::new(mock);
        assert_eq!(
            block_on(c.hello()).unwrap(),
            Hello {
                primary: false,
                secondary: true,
                max_wire_version: 21
            }
        );
    }

    #[test]
    fn a_server_error_is_an_error_with_its_code() {
        let (mock, _) = Mock::new(|_| {
            vec![
                ("ok".into(), Bson::Double(0.0)),
                ("errmsg".into(), Bson::str("no such command")),
                ("code".into(), Bson::Int32(59)),
            ]
        });
        let mut c = Connection::new(mock);
        assert_eq!(
            block_on(c.ping("x")).unwrap_err(),
            Error::Server {
                code: 59,
                message: "no such command".into()
            }
        );
    }

    #[test]
    fn a_reply_to_another_request_is_refused() {
        let (mut mock, _) = Mock::new(|_| ok());
        mock.wrong_response_to = true;
        let mut c = Connection::new(mock);
        assert!(matches!(block_on(c.ping("x")), Err(Error::Protocol(_))));
    }

    #[test]
    fn find_sends_a_bounded_read_only_query_and_returns_json() {
        let (mock, seen) = Mock::new(|_| {
            cursor(
                0,
                "firstBatch",
                vec![Bson::doc([
                    ("slug", Bson::str("harare")),
                    ("n", Bson::Int32(1)),
                ])],
            )
        });
        let mut c = Connection::new(mock);
        let rows = block_on(c.find(
            "places",
            "placesGeo",
            &FindOptions {
                filter: serde_json::json!({"isoCode": "ZW"}),
                projection: Some(serde_json::json!({"_id": 0})),
                sort: vec![("name".into(), 1), ("rank".into(), -1)],
                limit: 50_000,
                ..FindOptions::default()
            },
        ))
        .unwrap();
        assert_eq!(rows, vec![serde_json::json!({"slug": "harare", "n": 1})]);
        let sent = seen.borrow();
        let cmd = &sent[0];
        assert_eq!(name(cmd), "find");
        assert_eq!(get(cmd, "limit"), Some(&Bson::Int64(1_000)));
        assert_eq!(get(cmd, "singleBatch"), Some(&Bson::Bool(true)));
        assert_eq!(
            get(cmd, "$readPreference"),
            Some(&Bson::doc([("mode", Bson::str("secondaryPreferred"))]))
        );
        // The sort keeps its order.
        assert_eq!(
            get(cmd, "sort"),
            Some(&Bson::Doc(vec![
                ("name".into(), Bson::Int32(1)),
                ("rank".into(), Bson::Int32(-1))
            ]))
        );
        assert!(get(cmd, "maxTimeMS").is_some());
    }

    #[test]
    fn find_one_asks_for_one() {
        let (mock, seen) = Mock::new(|_| cursor(0, "firstBatch", vec![]));
        let mut c = Connection::new(mock);
        assert_eq!(
            block_on(c.find_one("places", "placesGeo", serde_json::json!({"a": 1}))).unwrap(),
            None
        );
        assert_eq!(get(&seen.borrow()[0], "limit"), Some(&Bson::Int64(1)));
    }

    #[test]
    fn bad_names_are_refused_before_anything_is_sent() {
        let (mock, seen) = Mock::new(|_| ok());
        let mut c = Connection::new(mock);
        for (db, coll) in [
            ("", "c"),
            ("d", ""),
            ("d$x", "c"),
            ("d", "c\0"),
            ("d", "a b"),
        ] {
            let r = block_on(c.find(db, coll, &FindOptions::default()));
            assert!(matches!(r, Err(Error::Refused(_))), "{db}/{coll}");
        }
        assert!(seen.borrow().is_empty());
    }

    #[test]
    fn aggregate_refuses_writes_and_follows_the_cursor() {
        let (mock, seen) = Mock::new(|req| match name(req).as_str() {
            "aggregate" => cursor(77, "firstBatch", vec![Bson::doc([("n", Bson::Int32(1))])]),
            "getMore" => cursor(0, "nextBatch", vec![Bson::doc([("n", Bson::Int32(2))])]),
            other => panic!("unexpected {other}"),
        });
        let mut c = Connection::new(mock);
        let r = block_on(c.aggregate(
            "weather",
            "observations",
            &[
                serde_json::json!({"$match": {"a": 1}}),
                serde_json::json!({"$out": "x"}),
            ],
        ));
        assert!(matches!(r, Err(Error::Refused(_))));
        assert!(seen.borrow().is_empty());
        let r = block_on(c.aggregate(
            "weather",
            "observations",
            &[serde_json::json!({"$match": {"a": 1}})],
        ))
        .unwrap();
        assert_eq!(
            r,
            vec![serde_json::json!({"n": 1}), serde_json::json!({"n": 2})]
        );
        let sent = seen.borrow();
        assert_eq!(name(&sent[1]), "getMore");
        assert_eq!(get(&sent[1], "getMore"), Some(&Bson::Int64(77)));
    }

    #[test]
    fn a_runaway_aggregation_is_cut_off_and_its_cursor_killed() {
        let (mock, seen) = Mock::new(|req| match name(req).as_str() {
            "killCursors" => ok(),
            _ => cursor(
                9,
                if name(req) == "aggregate" {
                    "firstBatch"
                } else {
                    "nextBatch"
                },
                (0..BATCH).map(Bson::Int32).collect(),
            ),
        });
        let mut c = Connection::new(mock);
        let r = block_on(c.aggregate("weather", "observations", &[]));
        assert!(matches!(r, Err(Error::Refused(_))));
        let sent = seen.borrow();
        assert_eq!(name(sent.last().unwrap()), "killCursors");
    }

    // ---- authentication against a server that runs SCRAM itself ----------

    use crate::testdata;

    fn salt() -> Vec<u8> {
        testdata::get("server_salt").into_bytes()
    }

    /// The server side of SCRAM-SHA-256 for `user` / `password`.
    fn scram_server(
        user: &'static str,
        password: String,
        break_signature: bool,
    ) -> impl FnMut(&Doc) -> Doc {
        let salt = salt();
        let nonce_tail = testdata::get("server_nonce_tail");
        let mut client_first_bare = String::new();
        let mut server_first = String::new();
        let mut combined = String::new();
        move |req: &Doc| {
            let payload = |d: &Doc| match get(d, "payload") {
                Some(Bson::Binary(b)) => String::from_utf8(b.clone()).unwrap(),
                _ => panic!("no payload"),
            };
            match name(req).as_str() {
                "saslStart" => {
                    let first = payload(req);
                    client_first_bare = first.strip_prefix("n,,").unwrap().to_owned();
                    let nonce = client_first_bare
                        .split(',')
                        .find_map(|p| p.strip_prefix("r="))
                        .unwrap();
                    combined = format!("{nonce}{nonce_tail}");
                    server_first = format!("r={combined},s={},i=4096", {
                        use base64::Engine;
                        base64::engine::general_purpose::STANDARD.encode(&salt)
                    });
                    let mut d = ok();
                    d.push(("conversationId".into(), Bson::Int32(1)));
                    d.push((
                        "payload".into(),
                        Bson::Binary(server_first.clone().into_bytes()),
                    ));
                    d.push(("done".into(), Bson::Bool(false)));
                    d
                }
                "saslContinue" => {
                    let salted = scram::salted_password(&password, &salt, 4096).unwrap();
                    let (expected_final, mut sig) =
                        scram::client_final(&salted, &client_first_bare, &server_first, &combined);
                    if payload(req) != expected_final {
                        return vec![
                            ("ok".into(), Bson::Double(0.0)),
                            ("code".into(), Bson::Int32(18)),
                            ("errmsg".into(), Bson::str("Authentication failed.")),
                        ];
                    }
                    if break_signature {
                        sig[0] ^= 0xff;
                    }
                    use base64::Engine;
                    let v = format!(
                        "v={}",
                        base64::engine::general_purpose::STANDARD.encode(sig)
                    );
                    let mut d = ok();
                    d.push(("conversationId".into(), Bson::Int32(1)));
                    d.push(("payload".into(), Bson::Binary(v.into_bytes())));
                    d.push(("done".into(), Bson::Bool(true)));
                    let _ = user;
                    d
                }
                other => panic!("unexpected {other}"),
            }
        }
    }

    fn uri(password: &str) -> Uri {
        crate::uri::parse(&format!("mongodb://weather:{password}@h1:27017/weather")).unwrap()
    }

    #[test]
    fn the_scram_handshake_completes_against_a_real_exchange() {
        let (mock, seen) = Mock::new(scram_server(
            "weather",
            testdata::get("good_password"),
            false,
        ));
        let mut c = Connection::new(mock);
        block_on(c.authenticate(
            &uri(&testdata::get("good_password")),
            &testdata::get("client_nonce"),
            &mut SaltCache::new(),
        ))
        .unwrap();
        let sent = seen.borrow();
        assert_eq!(name(&sent[0]), "saslStart");
        assert_eq!(
            get(&sent[0], "mechanism"),
            Some(&Bson::str("SCRAM-SHA-256"))
        );
        // Authenticates against `authSource`, not the data database.
        assert_eq!(sent[0].last().unwrap().1, Bson::str("admin"));
        assert_eq!(name(&sent[1]), "saslContinue");
        assert_eq!(sent.len(), 2, "skipEmptyExchange: no third round trip");
    }

    #[test]
    fn a_wrong_password_is_an_authentication_error() {
        let (mock, _) = Mock::new(scram_server(
            "weather",
            testdata::get("good_password"),
            false,
        ));
        let mut c = Connection::new(mock);
        let r = block_on(c.authenticate(
            &uri(&testdata::get("bad_password")),
            &testdata::get("client_nonce"),
            &mut SaltCache::new(),
        ));
        assert!(
            matches!(r, Err(Error::Auth(_))),
            "authentication was not refused"
        );
    }

    #[test]
    fn a_server_that_cannot_prove_the_password_is_refused() {
        let (mock, _) = Mock::new(scram_server(
            "weather",
            testdata::get("good_password"),
            true,
        ));
        let mut c = Connection::new(mock);
        let r = block_on(c.authenticate(
            &uri(&testdata::get("good_password")),
            &testdata::get("client_nonce"),
            &mut SaltCache::new(),
        ));
        assert!(
            matches!(r, Err(Error::Auth(_))),
            "authentication was not refused"
        );
    }

    #[test]
    fn the_salted_password_is_computed_once_per_isolate() {
        let (pw, other, salt) = (
            testdata::get("cache_password"),
            testdata::get("other_password"),
            testdata::get("short_salt").into_bytes(),
        );
        let mut cache = SaltCache::new();
        let a = cache.get_or_compute("u", &pw, &salt, 4096).unwrap();
        assert_eq!(cache.0.len(), 1);
        assert_eq!(a, cache.get_or_compute("u", &pw, &salt, 4096).unwrap());
        assert_eq!(cache.0.len(), 1);
        // Another password under the same key recomputes: a different result,
        // and the entry now holds the new password.
        let b = cache.get_or_compute("u", &other, &salt, 4096).unwrap();
        assert_ne!(a, b);
        assert_eq!(cache.0.len(), 1);
        assert_eq!(b, scram::salted_password(&other, &salt, 4096).unwrap());
        assert_eq!(b, cache.get_or_compute("u", &other, &salt, 4096).unwrap());
    }
}
