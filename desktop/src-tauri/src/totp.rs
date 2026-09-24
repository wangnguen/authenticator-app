//! TOTP theo RFC 6238 (dựa trên HOTP RFC 4226).

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Sha256, Sha512};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "UPPERCASE")]
pub enum Algorithm {
    #[default]
    Sha1,
    Sha256,
    Sha512,
}

impl Algorithm {
    pub fn parse(value: &str) -> Option<Self> {
        match value.to_ascii_uppercase().as_str() {
            "SHA1" => Some(Self::Sha1),
            "SHA256" => Some(Self::Sha256),
            "SHA512" => Some(Self::Sha512),
            _ => None,
        }
    }
}

fn hmac(algorithm: Algorithm, key: &[u8], message: &[u8]) -> Vec<u8> {
    // HMAC chấp nhận key với độ dài bất kỳ nên unwrap an toàn.
    match algorithm {
        Algorithm::Sha1 => {
            let mut mac = Hmac::<Sha1>::new_from_slice(key).unwrap();
            mac.update(message);
            mac.finalize().into_bytes().to_vec()
        }
        Algorithm::Sha256 => {
            let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
            mac.update(message);
            mac.finalize().into_bytes().to_vec()
        }
        Algorithm::Sha512 => {
            let mut mac = Hmac::<Sha512>::new_from_slice(key).unwrap();
            mac.update(message);
            mac.finalize().into_bytes().to_vec()
        }
    }
}

pub fn hotp(secret: &[u8], counter: u64, digits: u32, algorithm: Algorithm) -> String {
    let hash = hmac(algorithm, secret, &counter.to_be_bytes());
    let offset = (hash[hash.len() - 1] & 0x0f) as usize;
    let binary = u32::from_be_bytes([
        hash[offset] & 0x7f,
        hash[offset + 1],
        hash[offset + 2],
        hash[offset + 3],
    ]);
    let code = binary % 10u32.pow(digits);
    format!("{:0width$}", code, width = digits as usize)
}

/// Trả về (mã, thời điểm hết hạn tính bằng Unix ms).
pub fn totp(
    secret: &[u8],
    unix_ms: u64,
    period: u64,
    digits: u32,
    algorithm: Algorithm,
) -> (String, u64) {
    let counter = unix_ms / 1000 / period;
    let expires_at = (counter + 1) * period * 1000;
    (hotp(secret, counter, digits, algorithm), expires_at)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vector kiểm thử trong phụ lục B của RFC 6238.
    const SHA1_KEY: &[u8] = b"12345678901234567890";
    const SHA256_KEY: &[u8] = b"12345678901234567890123456789012";
    const SHA512_KEY: &[u8] =
        b"1234567890123456789012345678901234567890123456789012345678901234";

    fn code(key: &[u8], secs: u64, algorithm: Algorithm) -> String {
        totp(key, secs * 1000, 30, 8, algorithm).0
    }

    #[test]
    fn rfc6238_vectors() {
        assert_eq!(code(SHA1_KEY, 59, Algorithm::Sha1), "94287082");
        assert_eq!(code(SHA256_KEY, 59, Algorithm::Sha256), "46119246");
        assert_eq!(code(SHA512_KEY, 59, Algorithm::Sha512), "90693936");
        assert_eq!(code(SHA1_KEY, 1111111109, Algorithm::Sha1), "07081804");
        assert_eq!(code(SHA256_KEY, 1111111109, Algorithm::Sha256), "68084774");
        assert_eq!(code(SHA512_KEY, 1111111109, Algorithm::Sha512), "25091201");
        assert_eq!(code(SHA1_KEY, 20000000000, Algorithm::Sha1), "65353130");
    }

    #[test]
    fn expiry_is_end_of_period() {
        let (_, expires_at) = totp(SHA1_KEY, 59_000, 30, 6, Algorithm::Sha1);
        assert_eq!(expires_at, 60_000);
    }
}
