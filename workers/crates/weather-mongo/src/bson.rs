//! A small BSON codec: only the types the weather data uses.
//!
//! Documents are ordered (`Doc` is a `Vec`), because a MongoDB command must
//! start with its own name, which a sorted JSON map cannot guarantee. Results
//! decode to `serde_json::Value` in extended-JSON style, where the order of
//! keys does not matter:
//!
//! | BSON            | JSON                                    |
//! | --------------- | --------------------------------------- |
//! | double, int32/64| number                                  |
//! | string, bool, null, document, array | the same            |
//! | datetime        | `{"$date": <ms since the epoch>}`       |
//! | ObjectId        | `{"$oid": "<24 hex>"}`                  |
//! | binary          | `{"$binary": "<base64>"}`               |
//! | timestamp       | `{"$timestamp": <u64>}`                 |
//!
//! Anything else (decimal128, regex, javascript, …) is refused: nothing in the
//! weather collections uses it, and a silent lossy read would be worse.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{Map, Number, Value};

use crate::Error;

/// An ordered document.
pub type Doc = Vec<(String, Bson)>;

#[derive(Debug, Clone, PartialEq)]
pub enum Bson {
    Double(f64),
    Str(String),
    Doc(Doc),
    Array(Vec<Bson>),
    Binary(Vec<u8>),
    ObjectId([u8; 12]),
    Bool(bool),
    /// Milliseconds since the Unix epoch.
    DateTime(i64),
    Null,
    Int32(i32),
    Timestamp(u64),
    Int64(i64),
}

impl Bson {
    /// An ordered document from `(key, value)` pairs.
    pub fn doc<const N: usize>(pairs: [(&str, Bson); N]) -> Bson {
        Bson::Doc(pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
    }

    pub fn str(s: &str) -> Bson {
        Bson::Str(s.to_owned())
    }

    /// From JSON, keeping an object's keys in sorted order (use [`Bson::doc`]
    /// where order matters: a sort spec, a command). Integers that fit become
    /// int32, other integers int64, floats double; `{"$date": ms}`,
    /// `{"$oid": hex}` and `{"$binary": base64}` become their BSON types.
    pub fn from_json(v: &Value) -> Result<Bson, Error> {
        Ok(match v {
            Value::Null => Bson::Null,
            Value::Bool(b) => Bson::Bool(*b),
            Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    match i32::try_from(i) {
                        Ok(small) => Bson::Int32(small),
                        Err(_) => Bson::Int64(i),
                    }
                } else if let Some(u) = n.as_u64() {
                    Bson::Int64(
                        i64::try_from(u).map_err(|_| Error::Bson("integer too large".into()))?,
                    )
                } else {
                    Bson::Double(n.as_f64().ok_or_else(|| Error::Bson("bad number".into()))?)
                }
            }
            Value::String(s) => Bson::Str(s.clone()),
            Value::Array(a) => {
                Bson::Array(a.iter().map(Bson::from_json).collect::<Result<_, _>>()?)
            }
            Value::Object(m) => {
                if m.len() == 1 {
                    if let Some(ms) = m.get("$date").and_then(Value::as_i64) {
                        return Ok(Bson::DateTime(ms));
                    }
                    if let Some(hex) = m.get("$oid").and_then(Value::as_str) {
                        let bytes = hex::decode(hex).map_err(|_| Error::Bson("bad $oid".into()))?;
                        let id: [u8; 12] = bytes
                            .try_into()
                            .map_err(|_| Error::Bson("$oid must be 12 bytes".into()))?;
                        return Ok(Bson::ObjectId(id));
                    }
                    if let Some(b64) = m.get("$binary").and_then(Value::as_str) {
                        return Ok(Bson::Binary(
                            B64.decode(b64)
                                .map_err(|_| Error::Bson("bad $binary".into()))?,
                        ));
                    }
                }
                Bson::Doc(
                    m.iter()
                        .map(|(k, v)| Ok((k.clone(), Bson::from_json(v)?)))
                        .collect::<Result<_, Error>>()?,
                )
            }
        })
    }

    pub fn to_json(&self) -> Value {
        match self {
            Bson::Double(f) => Number::from_f64(*f).map_or(Value::Null, Value::Number),
            Bson::Str(s) => Value::String(s.clone()),
            Bson::Doc(d) => doc_to_json(d),
            Bson::Array(a) => Value::Array(a.iter().map(Bson::to_json).collect()),
            Bson::Binary(b) => serde_json::json!({ "$binary": B64.encode(b) }),
            Bson::ObjectId(id) => serde_json::json!({ "$oid": hex::encode(id) }),
            Bson::Bool(b) => Value::Bool(*b),
            Bson::DateTime(ms) => serde_json::json!({ "$date": ms }),
            Bson::Null => Value::Null,
            Bson::Int32(i) => Value::from(*i),
            Bson::Timestamp(t) => serde_json::json!({ "$timestamp": t }),
            Bson::Int64(i) => Value::from(*i),
        }
    }

    fn type_byte(&self) -> u8 {
        match self {
            Bson::Double(_) => 0x01,
            Bson::Str(_) => 0x02,
            Bson::Doc(_) => 0x03,
            Bson::Array(_) => 0x04,
            Bson::Binary(_) => 0x05,
            Bson::ObjectId(_) => 0x07,
            Bson::Bool(_) => 0x08,
            Bson::DateTime(_) => 0x09,
            Bson::Null => 0x0A,
            Bson::Int32(_) => 0x10,
            Bson::Timestamp(_) => 0x11,
            Bson::Int64(_) => 0x12,
        }
    }
}

pub fn doc_to_json(d: &Doc) -> Value {
    let mut m = Map::new();
    for (k, v) in d {
        m.insert(k.clone(), v.to_json());
    }
    Value::Object(m)
}

fn put_cstring(out: &mut Vec<u8>, s: &str) -> Result<(), Error> {
    if s.as_bytes().contains(&0) {
        return Err(Error::Bson("a key contains a NUL byte".into()));
    }
    out.extend_from_slice(s.as_bytes());
    out.push(0);
    Ok(())
}

fn put_value(out: &mut Vec<u8>, v: &Bson) -> Result<(), Error> {
    match v {
        Bson::Double(f) => out.extend_from_slice(&f.to_le_bytes()),
        Bson::Str(s) => {
            out.extend_from_slice(&((s.len() + 1) as i32).to_le_bytes());
            out.extend_from_slice(s.as_bytes());
            out.push(0);
        }
        Bson::Doc(d) => encode_into(out, d)?,
        Bson::Array(a) => {
            let as_doc: Doc = a
                .iter()
                .enumerate()
                .map(|(i, v)| (i.to_string(), v.clone()))
                .collect();
            encode_into(out, &as_doc)?;
        }
        Bson::Binary(b) => {
            out.extend_from_slice(&(b.len() as i32).to_le_bytes());
            out.push(0x00); // generic binary
            out.extend_from_slice(b);
        }
        Bson::ObjectId(id) => out.extend_from_slice(id),
        Bson::Bool(b) => out.push(u8::from(*b)),
        Bson::DateTime(ms) | Bson::Int64(ms) => out.extend_from_slice(&ms.to_le_bytes()),
        Bson::Null => {}
        Bson::Int32(i) => out.extend_from_slice(&i.to_le_bytes()),
        Bson::Timestamp(t) => out.extend_from_slice(&t.to_le_bytes()),
    }
    Ok(())
}

fn encode_into(out: &mut Vec<u8>, d: &Doc) -> Result<(), Error> {
    let start = out.len();
    out.extend_from_slice(&[0; 4]);
    for (k, v) in d {
        out.push(v.type_byte());
        put_cstring(out, k)?;
        put_value(out, v)?;
    }
    out.push(0);
    let len = (out.len() - start) as i32;
    out[start..start + 4].copy_from_slice(&len.to_le_bytes());
    Ok(())
}

/// Encode a document.
pub fn encode(d: &Doc) -> Result<Vec<u8>, Error> {
    let mut out = Vec::new();
    encode_into(&mut out, d)?;
    Ok(out)
}

/// Deepest document nesting accepted when decoding.
const MAX_DEPTH: usize = 100;

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], Error> {
        let end = self
            .pos
            .checked_add(n)
            .filter(|e| *e <= self.buf.len())
            .ok_or_else(|| Error::Bson("truncated document".into()))?;
        let s = &self.buf[self.pos..end];
        self.pos = end;
        Ok(s)
    }

    fn byte(&mut self) -> Result<u8, Error> {
        Ok(self.take(1)?[0])
    }

    fn i32(&mut self) -> Result<i32, Error> {
        Ok(i32::from_le_bytes(
            self.take(4)?.try_into().expect("4 bytes"),
        ))
    }

    fn i64(&mut self) -> Result<i64, Error> {
        Ok(i64::from_le_bytes(
            self.take(8)?.try_into().expect("8 bytes"),
        ))
    }

    fn cstring(&mut self) -> Result<String, Error> {
        let rest = &self.buf[self.pos..];
        let nul = rest
            .iter()
            .position(|b| *b == 0)
            .ok_or_else(|| Error::Bson("unterminated key".into()))?;
        let s = std::str::from_utf8(&rest[..nul])
            .map_err(|_| Error::Bson("key is not UTF-8".into()))?
            .to_owned();
        self.pos += nul + 1;
        Ok(s)
    }

    fn string(&mut self) -> Result<String, Error> {
        let len = self.i32()?;
        let len = usize::try_from(len)
            .ok()
            .filter(|l| *l >= 1)
            .ok_or_else(|| Error::Bson("bad string length".into()))?;
        let bytes = self.take(len)?;
        if bytes[len - 1] != 0 {
            return Err(Error::Bson("string is not NUL-terminated".into()));
        }
        std::str::from_utf8(&bytes[..len - 1])
            .map(str::to_owned)
            .map_err(|_| Error::Bson("string is not UTF-8".into()))
    }

    fn document(&mut self, depth: usize) -> Result<Doc, Error> {
        if depth > MAX_DEPTH {
            return Err(Error::Bson("document nested too deeply".into()));
        }
        let start = self.pos;
        let len = usize::try_from(self.i32()?)
            .ok()
            .filter(|l| *l >= 5)
            .ok_or_else(|| Error::Bson("bad document length".into()))?;
        let end = start
            .checked_add(len)
            .filter(|e| *e <= self.buf.len())
            .ok_or_else(|| Error::Bson("document longer than its buffer".into()))?;
        let mut out = Doc::new();
        loop {
            let t = self.byte()?;
            if t == 0 {
                break;
            }
            let key = self.cstring()?;
            let value = self.value(t, depth)?;
            out.push((key, value));
        }
        if self.pos != end {
            return Err(Error::Bson(
                "document length does not match its content".into(),
            ));
        }
        Ok(out)
    }

    fn value(&mut self, t: u8, depth: usize) -> Result<Bson, Error> {
        Ok(match t {
            0x01 => Bson::Double(f64::from_le_bytes(
                self.take(8)?.try_into().expect("8 bytes"),
            )),
            0x02 => Bson::Str(self.string()?),
            0x03 => Bson::Doc(self.document(depth + 1)?),
            0x04 => {
                let d = self.document(depth + 1)?;
                Bson::Array(d.into_iter().map(|(_, v)| v).collect())
            }
            0x05 => {
                let len = usize::try_from(self.i32()?)
                    .map_err(|_| Error::Bson("bad binary length".into()))?;
                let _subtype = self.byte()?;
                Bson::Binary(self.take(len)?.to_vec())
            }
            0x07 => Bson::ObjectId(self.take(12)?.try_into().expect("12 bytes")),
            0x08 => Bson::Bool(self.byte()? != 0),
            0x09 => Bson::DateTime(self.i64()?),
            0x0A => Bson::Null,
            0x10 => Bson::Int32(self.i32()?),
            0x11 => Bson::Timestamp(u64::from_le_bytes(
                self.take(8)?.try_into().expect("8 bytes"),
            )),
            0x12 => Bson::Int64(self.i64()?),
            other => return Err(Error::Bson(format!("unsupported BSON type 0x{other:02x}"))),
        })
    }
}

/// Decode one document from `bytes` (which must hold exactly that document).
pub fn decode(bytes: &[u8]) -> Result<Doc, Error> {
    let mut r = Reader { buf: bytes, pos: 0 };
    let d = r.document(0)?;
    if r.pos != bytes.len() {
        return Err(Error::Bson("trailing bytes after the document".into()));
    }
    Ok(d)
}

/// Decode one document that starts `bytes` and return it with the rest.
pub fn decode_prefix(bytes: &[u8]) -> Result<(Doc, &[u8]), Error> {
    let mut r = Reader { buf: bytes, pos: 0 };
    let d = r.document(0)?;
    Ok((d, &bytes[r.pos..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The "hello world" document from the BSON specification:
    // {"hello": "world"}
    const HELLO: [u8; 22] = [
        0x16, 0x00, 0x00, 0x00, 0x02, b'h', b'e', b'l', b'l', b'o', 0x00, 0x06, 0x00, 0x00, 0x00,
        b'w', b'o', b'r', b'l', b'd', 0x00, 0x00,
    ];
    // {"BSON": ["awesome", 5.05, 1986]}
    const AWESOME: [u8; 49] = [
        0x31, 0x00, 0x00, 0x00, 0x04, b'B', b'S', b'O', b'N', 0x00, 0x26, 0x00, 0x00, 0x00, 0x02,
        b'0', 0x00, 0x08, 0x00, 0x00, 0x00, b'a', b'w', b'e', b's', b'o', b'm', b'e', 0x00, 0x01,
        b'1', 0x00, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x14, 0x40, 0x10, b'2', 0x00, 0xc2, 0x07,
        0x00, 0x00, 0x00, 0x00,
    ];

    #[test]
    fn the_specification_examples_encode_exactly() {
        assert_eq!(
            encode(&vec![("hello".into(), Bson::str("world"))]).unwrap(),
            HELLO
        );
        let d = vec![(
            "BSON".to_owned(),
            Bson::Array(vec![
                Bson::str("awesome"),
                Bson::Double(5.05),
                Bson::Int32(1986),
            ]),
        )];
        assert_eq!(encode(&d).unwrap(), AWESOME);
    }

    #[test]
    fn the_specification_examples_decode() {
        assert_eq!(
            doc_to_json(&decode(&HELLO).unwrap()),
            serde_json::json!({"hello": "world"})
        );
        assert_eq!(
            doc_to_json(&decode(&AWESOME).unwrap()),
            serde_json::json!({"BSON": ["awesome", 5.05, 1986]})
        );
    }

    #[test]
    fn every_supported_type_round_trips() {
        let d = vec![
            ("d".to_owned(), Bson::Double(-0.5)),
            ("s".to_owned(), Bson::str("héllo")),
            (
                "o".to_owned(),
                Bson::doc([("n", Bson::Null), ("b", Bson::Bool(true))]),
            ),
            (
                "a".to_owned(),
                Bson::Array(vec![Bson::Int32(1), Bson::Int64(1 << 40)]),
            ),
            ("bin".to_owned(), Bson::Binary(vec![0, 1, 2, 255])),
            ("id".to_owned(), Bson::ObjectId([7; 12])),
            ("t".to_owned(), Bson::DateTime(1_700_000_000_123)),
            ("ts".to_owned(), Bson::Timestamp(42)),
        ];
        assert_eq!(decode(&encode(&d).unwrap()).unwrap(), d);
    }

    #[test]
    fn json_conversion_picks_the_smallest_integer_and_extended_types() {
        let v = serde_json::json!({
            "small": 5, "big": 5_000_000_000_i64, "f": 1.5,
            "when": {"$date": 1_700_000_000_000_i64},
            "id": {"$oid": "0123456789abcdef01234567"},
            "bin": {"$binary": "AQID"},
        });
        let Bson::Doc(d) = Bson::from_json(&v).unwrap() else {
            panic!("a document");
        };
        let get = |k: &str| d.iter().find(|(n, _)| n == k).unwrap().1.clone();
        assert_eq!(get("small"), Bson::Int32(5));
        assert_eq!(get("big"), Bson::Int64(5_000_000_000));
        assert_eq!(get("f"), Bson::Double(1.5));
        assert_eq!(get("when"), Bson::DateTime(1_700_000_000_000));
        assert_eq!(
            get("id"),
            Bson::ObjectId([
                0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67
            ])
        );
        assert_eq!(get("bin"), Bson::Binary(vec![1, 2, 3]));
    }

    #[test]
    fn extended_values_survive_json() {
        let d = vec![
            ("t".to_owned(), Bson::DateTime(5)),
            ("id".to_owned(), Bson::ObjectId([1; 12])),
        ];
        let json = doc_to_json(&d);
        assert_eq!(json["t"], serde_json::json!({"$date": 5}));
        let Bson::Doc(back) = Bson::from_json(&json).unwrap() else {
            panic!("a document");
        };
        assert!(back
            .iter()
            .any(|(k, v)| k == "t" && *v == Bson::DateTime(5)));
        assert!(back
            .iter()
            .any(|(k, v)| k == "id" && *v == Bson::ObjectId([1; 12])));
    }

    #[test]
    fn a_key_with_a_nul_byte_is_refused() {
        assert!(encode(&vec![("a\0b".into(), Bson::Null)]).is_err());
    }

    #[test]
    fn malformed_input_is_an_error_never_a_panic() {
        assert!(decode(&[]).is_err());
        assert!(decode(&[5, 0, 0, 0]).is_err()); // shorter than its length
        assert!(decode(&[4, 0, 0, 0, 0]).is_err()); // length below the minimum
                                                    // Length says 22 but the buffer is cut.
        assert!(decode(&HELLO[..15]).is_err());
        // A length that does not match the content.
        let mut bad = HELLO;
        bad[0] = 0x17;
        assert!(decode(&bad).is_err());
        // A string whose NUL is missing.
        let mut bad = HELLO;
        bad[20] = b'!';
        assert!(decode(&bad).is_err());
        // An unsupported type (decimal128, 0x13).
        let d = [0x0b, 0, 0, 0, 0x13, b'x', 0, 0, 0, 0, 0];
        assert!(decode(&d).is_err());
        // Trailing bytes.
        let mut more = HELLO.to_vec();
        more.push(0);
        assert!(decode(&more).is_err());
        assert!(decode_prefix(&more).is_ok());
    }

    #[test]
    fn deep_nesting_is_refused() {
        let mut v = Bson::Int32(1);
        for _ in 0..(MAX_DEPTH + 5) {
            v = Bson::doc([("a", v)]);
        }
        let bytes = encode(&vec![("a".into(), v)]).unwrap();
        assert!(decode(&bytes).is_err());
    }
}
