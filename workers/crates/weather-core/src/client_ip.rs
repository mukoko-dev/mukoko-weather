//! Which address a Worker keys a caller by: one header order for every Worker.
//!
//! The edge sets `CF-Connecting-IP` on every request from a visitor. An API
//! Worker stamps `X-Mukoko-Client-IP` on a service-binding call to a Worker
//! that has no public route. Cloudflare's header comes first: a visitor can
//! send `X-Mukoko-Client-IP` on a public route, but the edge always sets
//! `CF-Connecting-IP`, so the forged value is only read where the edge set
//! none (never on a public route).

/// The header an API Worker sets on a service-binding call.
pub const CLIENT_IP_HEADER: &str = "X-Mukoko-Client-IP";

/// The caller's address: the first non-empty of the two headers. A Worker
/// keeps its own fallback for `None` (`"unknown"`, `"service-binding"`).
pub fn pick(cf_connecting_ip: Option<&str>, forwarded: Option<&str>) -> Option<String> {
    [cf_connecting_ip, forwarded]
        .into_iter()
        .flatten()
        .find(|ip| !ip.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloudflare_header_wins_over_the_forwarded_one() {
        assert_eq!(
            pick(Some("203.0.113.7"), Some("198.51.100.1")).as_deref(),
            Some("203.0.113.7")
        );
    }

    #[test]
    fn forwarded_header_is_used_when_the_edge_set_none() {
        assert_eq!(
            pick(None, Some("198.51.100.1")).as_deref(),
            Some("198.51.100.1")
        );
    }

    #[test]
    fn empty_values_never_count() {
        assert_eq!(
            pick(Some(""), Some("198.51.100.1")).as_deref(),
            Some("198.51.100.1")
        );
        assert_eq!(pick(Some(""), Some("")), None);
        assert_eq!(pick(None, None), None);
    }

    #[test]
    fn the_header_name_is_pinned() {
        assert_eq!(CLIENT_IP_HEADER, "X-Mukoko-Client-IP");
    }
}
