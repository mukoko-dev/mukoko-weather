//! Hashes that Workers store or compare in place of a secret or an address.

use sha2::{Digest, Sha256};

/// Lower-case hex of the SHA-256 of `s`'s UTF-8 bytes (64 characters).
pub fn sha256_hex(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_published_vector() {
        // SHA-256 of "abc" (FIPS 180-2, appendix B.1).
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn is_lower_case_hex_of_64_characters() {
        let h = sha256_hex("");
        assert_eq!(h.len(), 64);
        assert!(h
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    }
}
