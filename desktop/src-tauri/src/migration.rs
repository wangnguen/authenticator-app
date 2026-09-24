//! Giải mã link export của Google Authenticator:
//! `otpauth-migration://offline?data=<base64 của protobuf MigrationPayload>`.
//!
//! ```proto
//! message MigrationPayload {
//!   repeated OtpParameters otp_parameters = 1;
//!   int32 version = 2; int32 batch_size = 3; int32 batch_index = 4; int32 batch_id = 5;
//! }
//! message OtpParameters {
//!   bytes secret = 1; string name = 2; string issuer = 3;
//!   Algorithm algorithm = 4;  // 0 không rõ, 1 SHA1, 2 SHA256, 3 SHA512, 4 MD5
//!   DigitCount digits = 5;    // 0 không rõ, 1 sáu số, 2 tám số
//!   OtpType type = 6;         // 0 không rõ, 1 HOTP, 2 TOTP
//!   int64 counter = 7;
//! }
//! ```

use crate::error::{AppError, AppResult};
use crate::totp::Algorithm;
use crate::vault::NewAccount;
use data_encoding::{BASE32_NOPAD, BASE64URL_NOPAD, BASE64_NOPAD};
use url::Url;

pub struct Parsed {
    pub accounts: Vec<NewAccount>,
    /// Số tài khoản bỏ qua vì chưa hỗ trợ (HOTP, MD5).
    pub unsupported: usize,
}

pub fn parse(url: &Url) -> AppResult<Parsed> {
    let data = url
        .query_pairs()
        .find(|(key, _)| key == "data")
        .map(|(_, value)| value.into_owned())
        .ok_or_else(|| AppError::invalid_uri("Link migration thiếu tham số data."))?;
    decode_payload(&decode_base64(&data)?)
}

fn decode_base64(data: &str) -> AppResult<Vec<u8>> {
    // query_pairs() đổi "+" thành dấu cách, nên phải đổi lại trước khi decode.
    let cleaned: String = data
        .trim()
        .trim_end_matches('=')
        .chars()
        .map(|c| if c == ' ' { '+' } else { c })
        .collect();
    BASE64_NOPAD
        .decode(cleaned.as_bytes())
        .or_else(|_| BASE64URL_NOPAD.decode(cleaned.as_bytes()))
        .map_err(|_| AppError::invalid_uri("Dữ liệu migration không phải base64 hợp lệ."))
}

fn decode_payload(bytes: &[u8]) -> AppResult<Parsed> {
    let invalid = || AppError::invalid_uri("Dữ liệu migration bị hỏng.");
    let mut parsed = Parsed {
        accounts: Vec::new(),
        unsupported: 0,
    };
    for (field, value) in read_fields(bytes).ok_or_else(invalid)? {
        if let (1, Value::Bytes(params)) = (field, value) {
            match decode_params(params).ok_or_else(invalid)? {
                Some(account) => parsed.accounts.push(account),
                None => parsed.unsupported += 1,
            }
        }
    }
    Ok(parsed)
}

/// `None` nếu tài khoản dùng loại/thuật toán chưa hỗ trợ.
fn decode_params(bytes: &[u8]) -> Option<Option<NewAccount>> {
    let mut secret: &[u8] = &[];
    let mut name = String::new();
    let mut issuer = String::new();
    let mut algorithm = 0;
    let mut digits = 0;
    let mut otp_type = 0;

    for (field, value) in read_fields(bytes)? {
        match (field, value) {
            (1, Value::Bytes(b)) => secret = b,
            (2, Value::Bytes(b)) => name = String::from_utf8_lossy(b).into_owned(),
            (3, Value::Bytes(b)) => issuer = String::from_utf8_lossy(b).into_owned(),
            (4, Value::Varint(v)) => algorithm = v,
            (5, Value::Varint(v)) => digits = v,
            (6, Value::Varint(v)) => otp_type = v,
            _ => {}
        }
    }

    let algorithm = match algorithm {
        0 | 1 => Algorithm::Sha1,
        2 => Algorithm::Sha256,
        3 => Algorithm::Sha512,
        _ => return Some(None),
    };
    if otp_type == 1 {
        return Some(None);
    }

    // name thường có dạng "Issuer:label" hoặc chỉ "label".
    let name = name.trim();
    let label = match name.split_once(':') {
        Some((prefix, rest)) if issuer.is_empty() || prefix.trim() == issuer.trim() => {
            if issuer.is_empty() {
                issuer = prefix.trim().to_string();
            }
            rest.trim().to_string()
        }
        _ => name.to_string(),
    };

    Some(Some(NewAccount {
        issuer: issuer.trim().to_string(),
        label,
        secret: BASE32_NOPAD.encode(secret),
        algorithm,
        digits: if digits == 2 { 8 } else { 6 },
        period: 30,
    }))
}

enum Value<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
}

/// Đọc các field protobuf ở mức wire format; bỏ qua field 32/64-bit.
fn read_fields(buf: &[u8]) -> Option<Vec<(u64, Value<'_>)>> {
    let mut pos = 0;
    let mut fields = Vec::new();
    while pos < buf.len() {
        let key = read_varint(buf, &mut pos)?;
        let field = key >> 3;
        match key & 7 {
            0 => fields.push((field, Value::Varint(read_varint(buf, &mut pos)?))),
            2 => {
                let len = read_varint(buf, &mut pos)? as usize;
                let end = pos.checked_add(len).filter(|&end| end <= buf.len())?;
                fields.push((field, Value::Bytes(&buf[pos..end])));
                pos = end;
            }
            1 => pos = pos.checked_add(8).filter(|&end| end <= buf.len())?,
            5 => pos = pos.checked_add(4).filter(|&end| end <= buf.len())?,
            _ => return None,
        }
    }
    Some(fields)
}

fn read_varint(buf: &[u8], pos: &mut usize) -> Option<u64> {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
        let byte = *buf.get(*pos)?;
        *pos += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use data_encoding::BASE64;

    fn varint(mut v: u64, out: &mut Vec<u8>) {
        while v >= 0x80 {
            out.push((v as u8) | 0x80);
            v >>= 7;
        }
        out.push(v as u8);
    }

    fn bytes_field(field: u64, data: &[u8], out: &mut Vec<u8>) {
        varint(field << 3 | 2, out);
        varint(data.len() as u64, out);
        out.extend_from_slice(data);
    }

    fn varint_field(field: u64, v: u64, out: &mut Vec<u8>) {
        varint(field << 3, out);
        varint(v, out);
    }

    fn params(secret: &[u8], name: &str, issuer: &str, alg: u64, digits: u64, kind: u64) -> Vec<u8> {
        let mut p = Vec::new();
        bytes_field(1, secret, &mut p);
        bytes_field(2, name.as_bytes(), &mut p);
        bytes_field(3, issuer.as_bytes(), &mut p);
        varint_field(4, alg, &mut p);
        varint_field(5, digits, &mut p);
        varint_field(6, kind, &mut p);
        p
    }

    fn migration_uri(entries: &[Vec<u8>]) -> Url {
        let mut payload = Vec::new();
        for entry in entries {
            bytes_field(1, entry, &mut payload);
        }
        varint_field(2, 1, &mut payload);
        varint_field(3, 1, &mut payload);
        varint_field(4, 0, &mut payload);
        let data = BASE64.encode(&payload);
        let encoded: String = url::form_urlencoded::byte_serialize(data.as_bytes()).collect();
        Url::parse(&format!("otpauth-migration://offline?data={encoded}")).unwrap()
    }

    #[test]
    fn decodes_multiple_accounts() {
        let url = migration_uri(&[
            params(b"12345678901234567890", "Example:alice@example.com", "Example", 1, 1, 2),
            params(b"abcdefghij", "bob", "", 2, 2, 2),
        ]);
        let parsed = parse(&url).unwrap();
        assert_eq!(parsed.unsupported, 0);
        assert_eq!(parsed.accounts.len(), 2);

        let alice = &parsed.accounts[0];
        assert_eq!(alice.issuer, "Example");
        assert_eq!(alice.label, "alice@example.com");
        assert_eq!(alice.secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
        assert_eq!(alice.algorithm, Algorithm::Sha1);
        assert_eq!(alice.digits, 6);
        assert_eq!(alice.period, 30);

        let bob = &parsed.accounts[1];
        assert_eq!(bob.issuer, "");
        assert_eq!(bob.label, "bob");
        assert_eq!(bob.algorithm, Algorithm::Sha256);
        assert_eq!(bob.digits, 8);
    }

    #[test]
    fn skips_hotp_and_md5() {
        let url = migration_uri(&[
            params(b"12345678901234567890", "hotp", "", 1, 1, 1),
            params(b"12345678901234567890", "md5", "", 4, 1, 2),
            params(b"12345678901234567890", "ok", "", 1, 1, 2),
        ]);
        let parsed = parse(&url).unwrap();
        assert_eq!(parsed.accounts.len(), 1);
        assert_eq!(parsed.unsupported, 2);
    }

    #[test]
    fn rejects_corrupt_data() {
        let url = Url::parse("otpauth-migration://offline?data=CmUKFAAA").unwrap();
        assert!(parse(&url).is_err());
        let url = Url::parse("otpauth-migration://offline").unwrap();
        assert!(parse(&url).is_err());
    }
}
