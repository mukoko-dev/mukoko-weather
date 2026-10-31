//! `OP_MSG` framing (opcode 2013), the only message MongoDB 5.1+ accepts for
//! commands. A message is a 16-byte header, 32 flag bits and sections; this
//! client sends one kind-0 section (a single command document) and expects
//! the same back.

use crate::bson::{self, Doc};
use crate::{Error, Result};

pub const OP_MSG: i32 = 2013;
const HEADER_LEN: usize = 16;
/// `flagBits` bit 0: a CRC-32C follows the sections.
const CHECKSUM_PRESENT: u32 = 1;
/// Larger replies than this are refused (the server's own limit is 48 MB).
pub const MAX_MESSAGE: usize = 48_000_000;

/// A command as one `OP_MSG` frame.
pub fn encode_request(request_id: i32, command: &Doc) -> Result<Vec<u8>> {
    let body = bson::encode(command)?;
    let len = HEADER_LEN + 4 + 1 + body.len();
    let mut out = Vec::with_capacity(len);
    out.extend_from_slice(&(len as i32).to_le_bytes());
    out.extend_from_slice(&request_id.to_le_bytes());
    out.extend_from_slice(&0_i32.to_le_bytes()); // responseTo
    out.extend_from_slice(&OP_MSG.to_le_bytes());
    out.extend_from_slice(&0_u32.to_le_bytes()); // flagBits
    out.push(0); // section kind 0
    out.extend_from_slice(&body);
    Ok(out)
}

/// The message length from a 16-byte header, checked.
pub fn message_length(header: &[u8; HEADER_LEN]) -> Result<usize> {
    let len = i32::from_le_bytes(header[0..4].try_into().expect("4 bytes"));
    let len = usize::try_from(len)
        .ok()
        .filter(|l| (HEADER_LEN + 5..=MAX_MESSAGE).contains(l))
        .ok_or_else(|| Error::Protocol(format!("bad message length {len}")))?;
    let opcode = i32::from_le_bytes(header[12..16].try_into().expect("4 bytes"));
    if opcode != OP_MSG {
        return Err(Error::Protocol(format!("unexpected opcode {opcode}")));
    }
    Ok(len)
}

/// The `responseTo` of a header.
pub fn response_to(header: &[u8; HEADER_LEN]) -> i32 {
    i32::from_le_bytes(header[8..12].try_into().expect("4 bytes"))
}

/// The reply document from the bytes after the header.
pub fn decode_reply(rest: &[u8]) -> Result<Doc> {
    if rest.len() < 5 {
        return Err(Error::Protocol("reply too short".into()));
    }
    let flags = u32::from_le_bytes(rest[0..4].try_into().expect("4 bytes"));
    let mut sections = &rest[4..];
    if flags & CHECKSUM_PRESENT != 0 {
        sections = sections
            .len()
            .checked_sub(4)
            .map(|n| &sections[..n])
            .ok_or_else(|| Error::Protocol("reply too short for its checksum".into()))?;
    }
    match sections.split_first() {
        Some((0, doc)) => bson::decode(doc),
        Some((kind, _)) => Err(Error::Protocol(format!("unexpected section kind {kind}"))),
        None => Err(Error::Protocol("reply has no section".into())),
    }
}

/// A reply frame, for tests and the scripted server.
pub fn encode_reply(response_to: i32, doc: &Doc) -> Result<Vec<u8>> {
    let mut frame = encode_request(0, doc)?;
    frame[8..12].copy_from_slice(&response_to.to_le_bytes());
    Ok(frame)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bson::Bson;

    #[test]
    fn a_request_has_the_op_msg_layout() {
        let cmd = vec![("ping".to_owned(), Bson::Int32(1))];
        let frame = encode_request(7, &cmd).unwrap();
        let body = bson::encode(&cmd).unwrap();
        assert_eq!(frame.len(), 16 + 4 + 1 + body.len());
        assert_eq!(
            i32::from_le_bytes(frame[0..4].try_into().unwrap()) as usize,
            frame.len()
        );
        assert_eq!(i32::from_le_bytes(frame[4..8].try_into().unwrap()), 7);
        assert_eq!(i32::from_le_bytes(frame[8..12].try_into().unwrap()), 0);
        assert_eq!(i32::from_le_bytes(frame[12..16].try_into().unwrap()), 2013);
        assert_eq!(&frame[16..20], &[0, 0, 0, 0]);
        assert_eq!(frame[20], 0);
        assert_eq!(&frame[21..], &body[..]);
    }

    #[test]
    fn a_reply_round_trips() {
        let doc = vec![("ok".to_owned(), Bson::Double(1.0))];
        let frame = encode_reply(7, &doc).unwrap();
        let header: [u8; 16] = frame[..16].try_into().unwrap();
        assert_eq!(message_length(&header).unwrap(), frame.len());
        assert_eq!(response_to(&header), 7);
        assert_eq!(decode_reply(&frame[16..]).unwrap(), doc);
    }

    #[test]
    fn a_checksum_is_skipped() {
        let doc = vec![("ok".to_owned(), Bson::Double(1.0))];
        let mut frame = encode_reply(1, &doc).unwrap();
        frame[16..20].copy_from_slice(&CHECKSUM_PRESENT.to_le_bytes());
        frame.extend_from_slice(&[9, 9, 9, 9]);
        assert_eq!(decode_reply(&frame[16..]).unwrap(), doc);
    }

    #[test]
    fn bad_headers_and_replies_are_refused() {
        let mut header = [0u8; 16];
        header[0..4].copy_from_slice(&1_000_i32.to_le_bytes());
        header[12..16].copy_from_slice(&2013_i32.to_le_bytes());
        assert_eq!(message_length(&header).unwrap(), 1_000);
        header[12..16].copy_from_slice(&2004_i32.to_le_bytes());
        assert!(message_length(&header).is_err());
        header[12..16].copy_from_slice(&2013_i32.to_le_bytes());
        header[0..4].copy_from_slice(&10_i32.to_le_bytes());
        assert!(message_length(&header).is_err());
        header[0..4].copy_from_slice(&(MAX_MESSAGE as i32 + 1).to_le_bytes());
        assert!(message_length(&header).is_err());
        header[0..4].copy_from_slice(&(-5_i32).to_le_bytes());
        assert!(message_length(&header).is_err());
        assert!(decode_reply(&[0, 0, 0, 0]).is_err());
        assert!(decode_reply(&[0, 0, 0, 0, 1, 5, 0, 0, 0, 0]).is_err()); // section kind 1
    }
}
