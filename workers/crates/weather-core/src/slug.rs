//! The slug character rule shared by every endpoint that takes a slug, a
//! rule key or an activity id.

/// `true` when every byte is `[a-z0-9-]`. The empty string passes; callers
/// that need at least one character check that themselves.
pub fn chars_ok(s: &str) -> bool {
    s.bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `^[a-z0-9-]{1,80}$`, the slug rule every location endpoint applies.
pub fn valid_slug(s: &str) -> bool {
    (1..=80).contains(&s.len()) && chars_ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_slug_rule_keeps_its_length_and_charset() {
        assert!(valid_slug("harare"));
        assert!(valid_slug("koh-samui--ksy4dd7"));
        assert!(!valid_slug(""));
        assert!(!valid_slug("Harare"));
        assert!(!valid_slug("a_b"));
        assert!(!valid_slug("a b"));
        assert!(valid_slug(&"a".repeat(80)));
        assert!(!valid_slug(&"a".repeat(81)));
    }

    #[test]
    fn chars_ok_has_no_length_limit_and_accepts_empty() {
        assert!(chars_ok(""));
        assert!(chars_ok(&"a".repeat(200)));
        assert!(!chars_ok("é"));
    }
}
