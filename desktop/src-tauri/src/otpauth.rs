//! Parse link `otpauth://totp/Issuer:label?secret=...&issuer=...`
//! (định dạng Key URI của Google Authenticator).

use crate::error::{AppError, AppResult};
use crate::migration::{self, Parsed};
use crate::totp::Algorithm;
use crate::vault::NewAccount;
use percent_encoding::percent_decode_str;
use url::Url;

/// Nhận một hoặc nhiều link (cách nhau bởi khoảng trắng/xuống dòng), mỗi link là
/// `otpauth://` hoặc `otpauth-migration://` (export từ Google Authenticator).
pub fn parse_many(input: &str) -> AppResult<Parsed> {
    let mut parsed = Parsed {
        accounts: Vec::new(),
        unsupported: 0,
    };
    for uri in input.split_whitespace() {
        let url = Url::parse(uri).map_err(|_| AppError::invalid_uri("Link không hợp lệ."))?;
        match url.scheme() {
            "otpauth" => parsed.accounts.push(parse_url(&url)?),
            "otpauth-migration" => {
                let batch = migration::parse(&url)?;
                parsed.accounts.extend(batch.accounts);
                parsed.unsupported += batch.unsupported;
            }
            _ => {
                return Err(AppError::invalid_uri(
                    "Link phải bắt đầu bằng otpauth:// hoặc otpauth-migration://",
                ))
            }
        }
    }
    if parsed.accounts.is_empty() && parsed.unsupported == 0 {
        return Err(AppError::invalid_uri("Chưa nhập link."));
    }
    Ok(parsed)
}

#[cfg(test)]
fn parse(uri: &str) -> AppResult<NewAccount> {
    let url = Url::parse(uri.trim()).map_err(|_| AppError::invalid_uri("Link không hợp lệ."))?;
    if url.scheme() != "otpauth" {
        return Err(AppError::invalid_uri("Link phải bắt đầu bằng otpauth://"));
    }
    parse_url(&url)
}

fn parse_url(url: &Url) -> AppResult<NewAccount> {
    match url.host_str() {
        Some("totp") => {}
        Some("hotp") => return Err(AppError::invalid_uri("Chưa hỗ trợ HOTP.")),
        _ => return Err(AppError::invalid_uri("Loại OTP không hợp lệ.")),
    }

    let path = percent_decode_str(url.path().trim_start_matches('/'))
        .decode_utf8_lossy()
        .into_owned();
    let (path_issuer, label) = match path.split_once(':') {
        Some((issuer, label)) => (issuer.trim().to_string(), label.trim().to_string()),
        None => (String::new(), path.trim().to_string()),
    };

    let mut account = NewAccount {
        issuer: path_issuer,
        label,
        ..NewAccount::default()
    };

    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "secret" => account.secret = value.into_owned(),
            "issuer" if !value.trim().is_empty() => account.issuer = value.trim().to_string(),
            "algorithm" => {
                account.algorithm = Algorithm::parse(&value)
                    .ok_or_else(|| AppError::invalid_uri("Thuật toán không hỗ trợ."))?
            }
            "digits" => {
                account.digits = value
                    .parse()
                    .map_err(|_| AppError::invalid_uri("Số chữ số không hợp lệ."))?
            }
            "period" => {
                account.period = value
                    .parse()
                    .map_err(|_| AppError::invalid_uri("Chu kỳ không hợp lệ."))?
            }
            _ => {}
        }
    }

    if account.secret.is_empty() {
        return Err(AppError::invalid_uri("Link thiếu secret."));
    }
    Ok(account)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_uri() {
        let account = parse(
            "otpauth://totp/ACME%20Co:john@example.com?secret=JBSWY3DPEHPK3PXP&issuer=ACME%20Co&algorithm=SHA256&digits=8&period=60",
        )
        .unwrap();
        assert_eq!(account.issuer, "ACME Co");
        assert_eq!(account.label, "john@example.com");
        assert_eq!(account.secret, "JBSWY3DPEHPK3PXP");
        assert_eq!(account.algorithm, Algorithm::Sha256);
        assert_eq!(account.digits, 8);
        assert_eq!(account.period, 60);
    }

    #[test]
    fn uses_defaults() {
        let account = parse("otpauth://totp/alice?secret=JBSWY3DPEHPK3PXP").unwrap();
        assert_eq!(account.issuer, "");
        assert_eq!(account.label, "alice");
        assert_eq!(account.algorithm, Algorithm::Sha1);
        assert_eq!(account.digits, 6);
        assert_eq!(account.period, 30);
    }

    #[test]
    fn parses_multiple_lines() {
        let parsed = parse_many(
            "otpauth://totp/a?secret=JBSWY3DPEHPK3PXP\n  otpauth://totp/b?secret=GEZDGNBVGY3TQOJQ\n",
        )
        .unwrap();
        assert_eq!(parsed.accounts.len(), 2);
        assert_eq!(parsed.accounts[1].label, "b");
        assert!(parse_many("   ").is_err());
        assert!(parse_many("https://example.com").is_err());
    }

    #[test]
    fn rejects_bad_input() {
        assert!(parse("https://example.com").is_err());
        assert!(parse("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1").is_err());
        assert!(parse("otpauth://totp/x").is_err());
    }
}
