//! The connection string: `mongodb://user:pass@host1:27017,host2:27017/db?authSource=admin&replicaSet=rs`.
//!
//! The seed-list form only. A Worker has no DNS client, so `mongodb+srv://`
//! (a DNS SRV lookup) is refused with a message that says how to get the
//! equivalent string from Atlas ("Connect" → "Drivers" → pick an older
//! driver version to show the `mongodb://` form with every shard host).
//! TLS is always on. The password is percent-decoded and kept out of every
//! `Debug` and error message.

use crate::{Error, Result};

#[derive(Clone, PartialEq, Eq)]
pub struct Uri {
    pub user: String,
    pub password: String,
    /// `(host, port)` in the order given.
    pub hosts: Vec<(String, u16)>,
    /// The default database in the path, if any.
    pub database: Option<String>,
    pub auth_source: String,
    pub replica_set: Option<String>,
}

impl std::fmt::Debug for Uri {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Uri")
            .field("user", &self.user)
            .field("password", &"<redacted>")
            .field("hosts", &self.hosts)
            .field("database", &self.database)
            .field("auth_source", &self.auth_source)
            .finish()
    }
}

fn bad(m: &str) -> Error {
    Error::Uri(m.to_owned())
}

fn percent_decode(s: &str) -> Result<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s
                .get(i + 1..i + 3)
                .ok_or_else(|| bad("a truncated %-escape"))?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| bad("a bad %-escape"))?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| bad("a %-escape is not UTF-8"))
}

fn host_port(h: &str) -> Result<(String, u16)> {
    if h.starts_with('[') {
        return Err(bad("IPv6 literals are not supported"));
    }
    match h.rsplit_once(':') {
        Some((host, port)) => Ok((
            host.to_ascii_lowercase(),
            port.parse::<u16>().map_err(|_| bad("a bad port"))?,
        )),
        None => Ok((h.to_ascii_lowercase(), 27017)),
    }
}

pub fn parse(uri: &str) -> Result<Uri> {
    let uri = uri.trim();
    if uri.starts_with("mongodb+srv://") {
        return Err(bad(
            "mongodb+srv needs a DNS lookup a Worker cannot make: use the mongodb:// seed-list \
             string (every shard host listed)",
        ));
    }
    let rest = uri
        .strip_prefix("mongodb://")
        .ok_or_else(|| bad("must start with mongodb://"))?;
    let (authority, tail) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i + 1..]),
        None => (rest, ""),
    };
    let (creds, hosts) = authority
        .rsplit_once('@')
        .ok_or_else(|| bad("user and password are required"))?;
    let (user, password) = creds
        .split_once(':')
        .ok_or_else(|| bad("user and password are required"))?;
    let (user, password) = (percent_decode(user)?, percent_decode(password)?);
    if user.is_empty() || password.is_empty() {
        return Err(bad("user and password are required"));
    }
    let hosts = hosts
        .split(',')
        .filter(|h| !h.is_empty())
        .map(host_port)
        .collect::<Result<Vec<_>>>()?;
    if hosts.is_empty() {
        return Err(bad("no host"));
    }
    let (path, query) = match tail.split_once('?') {
        Some((p, q)) => (p, q),
        None => (tail, ""),
    };
    let database = (!path.is_empty())
        .then(|| percent_decode(path))
        .transpose()?;
    let mut auth_source = "admin".to_owned();
    let mut replica_set = None;
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k.to_ascii_lowercase().as_str() {
            "authsource" => auth_source = percent_decode(v)?,
            "replicaset" => replica_set = Some(percent_decode(v)?),
            "tls" | "ssl" if v.eq_ignore_ascii_case("false") => {
                return Err(bad("TLS cannot be turned off"))
            }
            _ => {}
        }
    }
    Ok(Uri {
        user,
        password,
        hosts,
        database,
        auth_source,
        replica_set,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_seed_list_string_parses() {
        let u = parse(
            "mongodb://app%40x:p%3Ass%2Fw@ac-1-shard-00-00.abc.mongodb.net:27017,\
             Ac-1-shard-00-01.abc.mongodb.net/weather?replicaSet=atlas-xyz-shard-0&authSource=admin&tls=true",
        )
        .unwrap();
        assert_eq!(u.user, "app@x");
        assert_eq!(u.password, "p:ss/w");
        assert_eq!(
            u.hosts,
            vec![
                ("ac-1-shard-00-00.abc.mongodb.net".to_owned(), 27017),
                ("ac-1-shard-00-01.abc.mongodb.net".to_owned(), 27017),
            ]
        );
        assert_eq!(u.database.as_deref(), Some("weather"));
        assert_eq!(u.auth_source, "admin");
        assert_eq!(u.replica_set.as_deref(), Some("atlas-xyz-shard-0"));
    }

    #[test]
    fn defaults_and_ports() {
        let u = parse("mongodb://u:p@h1:1234").unwrap();
        assert_eq!(u.hosts, vec![("h1".to_owned(), 1234)]);
        assert_eq!(u.auth_source, "admin");
        assert_eq!(u.database, None);
    }

    #[test]
    fn srv_and_bad_strings_are_refused_with_a_way_forward() {
        let e = parse("mongodb+srv://u:p@cluster.mongodb.net/db").unwrap_err();
        assert!(e.to_string().contains("seed-list"));
        assert!(parse("http://x").is_err());
        assert!(parse("mongodb://h1").is_err()); // no credentials
        assert!(parse("mongodb://u@h1").is_err()); // no password
        assert!(parse("mongodb://u:@h1").is_err());
        assert!(parse("mongodb://u:p@").is_err());
        assert!(parse("mongodb://u:p@h1:notaport").is_err());
        assert!(parse("mongodb://u:p@[::1]:27017").is_err());
        assert!(parse("mongodb://u:p%zz@h1").is_err());
        assert!(parse("mongodb://u:p@h1/?tls=false").is_err());
    }

    #[test]
    fn the_password_never_appears_in_debug_or_errors() {
        let u = parse("mongodb://user:sup3rsecret@h1/db").unwrap();
        assert!(!format!("{u:?}").contains("sup3rsecret"));
        let e = parse("mongodb://user:sup3rsecret@h1:bad/db").unwrap_err();
        assert!(!e.to_string().contains("sup3rsecret"));
    }
}
