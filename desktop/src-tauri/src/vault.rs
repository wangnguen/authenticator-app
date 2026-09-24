//! Vault mã hoá: key = Argon2id(master password, salt), dữ liệu = AES-256-GCM.
//! Key chỉ nằm trong RAM khi vault đang mở và được xoá (zeroize) khi khoá.

use crate::error::{AppError, AppResult};
use crate::totp::{self, Algorithm};
use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, KeyInit, OsRng, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Argon2, Params, Version};
use data_encoding::{Encoding, BASE32_NOPAD, BASE64};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use zeroize::Zeroizing;

pub type SharedVault = Arc<Mutex<Vault>>;

const FILE_VERSION: u32 = 1;
const AAD: &[u8] = b"authenticator-vault-v1";
pub const MIN_PASSWORD_LEN: usize = 8;

/// Base32 không padding, bỏ qua trailing bits (một số dịch vụ sinh secret như vậy).
static BASE32: LazyLock<Encoding> = LazyLock::new(|| {
    let mut spec = BASE32_NOPAD.specification();
    spec.check_trailing_bits = false;
    spec.encoding().expect("valid base32 spec")
});

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Account {
    id: String,
    issuer: String,
    label: String,
    /// Base32 đã chuẩn hoá (in hoa, không padding).
    secret: String,
    algorithm: Algorithm,
    digits: u32,
    period: u64,
    created_at: u64,
}

/// Dữ liệu tài khoản mới, từ form nhập tay hoặc từ link otpauth://.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NewAccount {
    pub issuer: String,
    pub label: String,
    pub secret: String,
    pub algorithm: Algorithm,
    pub digits: u32,
    pub period: u64,
}

impl Default for NewAccount {
    fn default() -> Self {
        Self {
            issuer: String::new(),
            label: String::new(),
            secret: String::new(),
            algorithm: Algorithm::Sha1,
            digits: 6,
            period: 30,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeEntry {
    pub id: String,
    pub issuer: String,
    pub label: String,
    pub code: String,
    pub digits: u32,
    pub period: u64,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub id: String,
    pub issuer: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultStatus {
    pub exists: bool,
    pub unlocked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KdfParams {
    salt: String,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
}

impl KdfParams {
    fn generate() -> Self {
        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);
        // Tham số khuyến nghị của OWASP cho Argon2id.
        Self {
            salt: BASE64.encode(&salt),
            memory_kib: 19 * 1024,
            iterations: 2,
            parallelism: 1,
        }
    }

    fn derive_key(&self, password: &str) -> AppResult<Zeroizing<[u8; 32]>> {
        let salt = BASE64.decode(self.salt.as_bytes()).map_err(AppError::internal)?;
        let params = Params::new(self.memory_kib, self.iterations, self.parallelism, Some(32))
            .map_err(AppError::internal)?;
        let mut key = Zeroizing::new([0u8; 32]);
        Argon2::new(argon2::Algorithm::Argon2id, Version::V0x13, params)
            .hash_password_into(password.as_bytes(), &salt, key.as_mut_slice())
            .map_err(AppError::internal)?;
        Ok(key)
    }
}

#[derive(Serialize, Deserialize)]
struct VaultFile {
    version: u32,
    kdf: KdfParams,
    nonce: String,
    ciphertext: String,
}

struct Unlocked {
    key: Zeroizing<[u8; 32]>,
    kdf: KdfParams,
    accounts: Vec<Account>,
}

pub struct Vault {
    path: PathBuf,
    unlocked: Option<Unlocked>,
}

impl Vault {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            unlocked: None,
        }
    }

    pub fn status(&self) -> VaultStatus {
        VaultStatus {
            exists: self.path.exists(),
            unlocked: self.unlocked.is_some(),
        }
    }

    pub fn create(&mut self, password: &str) -> AppResult<()> {
        if self.path.exists() {
            return Err(AppError::vault_exists());
        }
        if password.chars().count() < MIN_PASSWORD_LEN {
            return Err(AppError::new(
                "WEAK_PASSWORD",
                format!("Mật khẩu cần ít nhất {MIN_PASSWORD_LEN} ký tự."),
            ));
        }
        let kdf = KdfParams::generate();
        let key = kdf.derive_key(password)?;
        self.unlocked = Some(Unlocked {
            key,
            kdf,
            accounts: Vec::new(),
        });
        self.save()
    }

    pub fn unlock(&mut self, password: &str) -> AppResult<()> {
        if !self.path.exists() {
            return Err(AppError::no_vault());
        }
        let file: VaultFile = serde_json::from_slice(&fs::read(&self.path)?)?;
        if file.version != FILE_VERSION {
            return Err(AppError::internal(format!(
                "Phiên bản vault không hỗ trợ: {}",
                file.version
            )));
        }
        let key = file.kdf.derive_key(password)?;
        let nonce = BASE64.decode(file.nonce.as_bytes()).map_err(AppError::internal)?;
        let ciphertext = BASE64
            .decode(file.ciphertext.as_bytes())
            .map_err(AppError::internal)?;
        if nonce.len() != 12 {
            return Err(AppError::internal("Nonce không hợp lệ."));
        }

        let cipher = Aes256Gcm::new_from_slice(key.as_slice()).map_err(AppError::internal)?;
        let plaintext = Zeroizing::new(
            cipher
                .decrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: &ciphertext,
                        aad: AAD,
                    },
                )
                .map_err(|_| AppError::wrong_password())?,
        );
        let accounts: Vec<Account> = serde_json::from_slice(&plaintext)?;

        self.unlocked = Some(Unlocked {
            key,
            kdf: file.kdf,
            accounts,
        });
        Ok(())
    }

    pub fn lock(&mut self) {
        self.unlocked = None;
    }

    fn unlocked(&self) -> AppResult<&Unlocked> {
        self.unlocked.as_ref().ok_or_else(AppError::locked)
    }

    fn unlocked_mut(&mut self) -> AppResult<&mut Unlocked> {
        self.unlocked.as_mut().ok_or_else(AppError::locked)
    }

    pub fn codes(&self) -> AppResult<Vec<CodeEntry>> {
        let now = now_ms();
        let mut entries: Vec<CodeEntry> = self
            .unlocked()?
            .accounts
            .iter()
            .map(|acc| {
                let secret = Zeroizing::new(
                    BASE32
                        .decode(acc.secret.as_bytes())
                        .unwrap_or_default(),
                );
                let (code, expires_at) =
                    totp::totp(&secret, now, acc.period, acc.digits, acc.algorithm);
                CodeEntry {
                    id: acc.id.clone(),
                    issuer: acc.issuer.clone(),
                    label: acc.label.clone(),
                    code,
                    digits: acc.digits,
                    period: acc.period,
                    expires_at,
                }
            })
            .collect();
        entries.sort_by_key(|e| (e.issuer.to_lowercase(), e.label.to_lowercase()));
        Ok(entries)
    }

    pub fn add(&mut self, new: NewAccount) -> AppResult<AccountSummary> {
        let secret = normalize_secret(&new.secret)?;
        let issuer = new.issuer.trim().to_string();
        let label = new.label.trim().to_string();
        if issuer.is_empty() && label.is_empty() {
            return Err(AppError::invalid_account("Cần nhập tên dịch vụ hoặc tài khoản."));
        }
        if !(6..=8).contains(&new.digits) {
            return Err(AppError::invalid_account("Số chữ số phải từ 6 đến 8."));
        }
        if !(1..=300).contains(&new.period) {
            return Err(AppError::invalid_account("Chu kỳ phải từ 1 đến 300 giây."));
        }

        let unlocked = self.unlocked_mut()?;
        if unlocked.accounts.iter().any(|a| a.secret == secret) {
            return Err(AppError::invalid_account("Tài khoản này đã tồn tại."));
        }
        let account = Account {
            id: uuid::Uuid::new_v4().to_string(),
            issuer,
            label,
            secret,
            algorithm: new.algorithm,
            digits: new.digits,
            period: new.period,
            created_at: now_ms(),
        };
        let summary = AccountSummary {
            id: account.id.clone(),
            issuer: account.issuer.clone(),
            label: account.label.clone(),
        };
        unlocked.accounts.push(account);
        self.save()?;
        Ok(summary)
    }

    pub fn remove(&mut self, id: &str) -> AppResult<()> {
        let unlocked = self.unlocked_mut()?;
        let before = unlocked.accounts.len();
        unlocked.accounts.retain(|a| a.id != id);
        if unlocked.accounts.len() == before {
            return Err(AppError::not_found());
        }
        self.save()
    }

    fn save(&self) -> AppResult<()> {
        let unlocked = self.unlocked()?;
        let plaintext = Zeroizing::new(serde_json::to_vec(&unlocked.accounts)?);
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);

        let cipher =
            Aes256Gcm::new_from_slice(unlocked.key.as_slice()).map_err(AppError::internal)?;
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &plaintext,
                    aad: AAD,
                },
            )
            .map_err(AppError::internal)?;

        let file = VaultFile {
            version: FILE_VERSION,
            kdf: unlocked.kdf.clone(),
            nonce: BASE64.encode(&nonce),
            ciphertext: BASE64.encode(&ciphertext),
        };

        // Ghi ra file tạm rồi rename để không làm hỏng vault nếu bị ngắt giữa chừng.
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&file)?)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

fn normalize_secret(secret: &str) -> AppResult<String> {
    let normalized: String = secret
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '=')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if normalized.is_empty() {
        return Err(AppError::invalid_account("Secret không được để trống."));
    }
    BASE32
        .decode(normalized.as_bytes())
        .map_err(|_| AppError::invalid_account("Secret phải là chuỗi Base32 hợp lệ."))?;
    Ok(normalized)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault() -> Vault {
        let path = std::env::temp_dir()
            .join(format!("auth-test-{}", uuid::Uuid::new_v4()))
            .join("vault.json");
        Vault::new(path)
    }

    fn sample() -> NewAccount {
        NewAccount {
            issuer: "GitHub".into(),
            label: "me@example.com".into(),
            secret: "jbsw y3dp ehpk 3pxp".into(),
            ..NewAccount::default()
        }
    }

    #[test]
    fn create_add_lock_unlock_roundtrip() {
        let mut vault = temp_vault();
        vault.create("correct horse").unwrap();
        vault.add(sample()).unwrap();
        vault.lock();
        assert!(matches!(vault.codes(), Err(e) if e.code == "LOCKED"));

        assert_eq!(vault.unlock("wrong password").unwrap_err().code, "WRONG_PASSWORD");
        vault.unlock("correct horse").unwrap();
        let codes = vault.codes().unwrap();
        assert_eq!(codes.len(), 1);
        assert_eq!(codes[0].issuer, "GitHub");
        assert_eq!(codes[0].code.len(), 6);

        vault.remove(&codes[0].id).unwrap();
        assert!(vault.codes().unwrap().is_empty());
        let _ = fs::remove_dir_all(vault.path.parent().unwrap());
    }

    #[test]
    fn rejects_duplicates_and_bad_secrets() {
        let mut vault = temp_vault();
        vault.create("correct horse").unwrap();
        vault.add(sample()).unwrap();
        assert_eq!(vault.add(sample()).unwrap_err().code, "INVALID_ACCOUNT");

        let bad = NewAccount {
            secret: "not base32!".into(),
            ..sample()
        };
        assert_eq!(vault.add(bad).unwrap_err().code, "INVALID_ACCOUNT");
        let _ = fs::remove_dir_all(vault.path.parent().unwrap());
    }

    #[test]
    fn rejects_short_password() {
        let mut vault = temp_vault();
        assert_eq!(vault.create("short").unwrap_err().code, "WEAK_PASSWORD");
    }
}
