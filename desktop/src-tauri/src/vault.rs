//! Vault mã hoá AES-256-GCM. Key lấy từ một trong hai nguồn:
//! - có master password: key = Argon2id(password, salt)
//! - không có mật khẩu: key ngẫu nhiên, được Windows DPAPI khoá theo tài khoản Windows
//! Key chỉ nằm trong RAM khi vault đang mở và được xoá (zeroize) khi khoá.

use crate::dpapi;
use crate::error::{AppError, AppResult};
use crate::otpauth;
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

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub added: Vec<AccountSummary>,
    /// Số tài khoản bỏ qua vì đã có trong vault.
    pub duplicates: usize,
    /// Số tài khoản bỏ qua vì chưa hỗ trợ (HOTP, MD5).
    pub unsupported: usize,
}

const PLAIN_BACKUP_FORMAT: &str = "authenticator-plain-backup";

/// Bản sao lưu của vault không mật khẩu: danh sách tài khoản dạng JSON, không mã hoá.
#[derive(Serialize, Deserialize)]
struct PlainBackup {
    format: String,
    version: u32,
    accounts: Vec<Account>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPreview {
    pub issuer: String,
    pub label: String,
    pub algorithm: Algorithm,
    pub digits: u32,
    pub period: u64,
    /// Đã có trong vault (hoặc lặp lại trong cùng lần import), sẽ bị bỏ qua.
    pub duplicate: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub accounts: Vec<AccountPreview>,
    /// Số tài khoản chưa hỗ trợ (HOTP, MD5), sẽ bị bỏ qua.
    pub unsupported: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub exists: bool,
    pub unlocked: bool,
    /// false: vault không có master password, key được Windows (DPAPI) giữ.
    pub has_password: bool,
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

/// Cách bảo vệ key của vault.
#[derive(Clone)]
enum Protection {
    /// key = Argon2id(master password).
    Password(KdfParams),
    /// key ngẫu nhiên, được DPAPI khoá theo tài khoản Windows (base64 của blob DPAPI).
    Device(String),
}

impl Protection {
    /// Tạo key mới: có mật khẩu thì dùng Argon2id, không có thì dùng DPAPI.
    fn generate(password: Option<&str>) -> AppResult<(Zeroizing<[u8; 32]>, Self)> {
        match password {
            Some(password) => {
                check_password(password)?;
                let kdf = KdfParams::generate();
                Ok((kdf.derive_key(password)?, Self::Password(kdf)))
            }
            None => {
                let mut key = Zeroizing::new([0u8; 32]);
                OsRng.fill_bytes(key.as_mut_slice());
                let wrapped = dpapi::protect(key.as_slice()).map_err(AppError::internal)?;
                Ok((key, Self::Device(BASE64.encode(&wrapped))))
            }
        }
    }

    fn key(&self, password: Option<&str>) -> AppResult<Zeroizing<[u8; 32]>> {
        match self {
            Self::Password(kdf) => kdf.derive_key(password.ok_or_else(AppError::locked)?),
            Self::Device(wrapped) => {
                let blob = BASE64.decode(wrapped.as_bytes()).map_err(AppError::internal)?;
                let raw = dpapi::unprotect(&blob).map_err(|_| {
                    AppError::new(
                        "DEVICE_KEY",
                        "Không mở được vault bằng tài khoản Windows này (vault được tạo trên máy hoặc user khác).",
                    )
                })?;
                let key: [u8; 32] = raw
                    .as_slice()
                    .try_into()
                    .map_err(|_| AppError::internal("Key trong vault không hợp lệ."))?;
                Ok(Zeroizing::new(key))
            }
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultFile {
    version: u32,
    /// Có khi vault dùng master password.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    kdf: Option<KdfParams>,
    /// Có khi vault không dùng mật khẩu (key được DPAPI khoá).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    device_key: Option<String>,
    nonce: String,
    ciphertext: String,
}

impl VaultFile {
    fn protection(&self) -> AppResult<Protection> {
        match (&self.kdf, &self.device_key) {
            (Some(kdf), _) => Ok(Protection::Password(kdf.clone())),
            (None, Some(wrapped)) => Ok(Protection::Device(wrapped.clone())),
            (None, None) => Err(AppError::internal("File vault thiếu thông tin key.")),
        }
    }
}

struct Unlocked {
    key: Zeroizing<[u8; 32]>,
    protection: Protection,
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
        let has_password = match &self.unlocked {
            Some(unlocked) => matches!(unlocked.protection, Protection::Password(_)),
            None => self.read_file().map(|f| f.kdf.is_some()).unwrap_or(false),
        };
        VaultStatus {
            exists: self.path.exists(),
            unlocked: self.unlocked.is_some(),
            has_password,
        }
    }

    /// `password = None`: vault không có mật khẩu, tự mở khoá bằng tài khoản Windows.
    pub fn create(&mut self, password: Option<&str>) -> AppResult<()> {
        if self.path.exists() {
            return Err(AppError::vault_exists());
        }
        let (key, protection) = Protection::generate(password)?;
        self.unlocked = Some(Unlocked {
            key,
            protection,
            accounts: Vec::new(),
        });
        self.save()
    }

    /// Mở khoá vault. Vault không có mật khẩu thì bỏ qua `password`.
    pub fn unlock(&mut self, password: Option<&str>) -> AppResult<()> {
        if !self.path.exists() {
            return Err(AppError::no_vault());
        }
        let file = self.read_file()?;
        if file.version != FILE_VERSION {
            return Err(AppError::internal(format!(
                "Phiên bản vault không hỗ trợ: {}",
                file.version
            )));
        }
        let protection = file.protection()?;
        let key = protection.key(password)?;
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
            protection,
            accounts,
        });
        Ok(())
    }

    /// Gọi lúc app khởi động: tự mở vault nếu vault không dùng mật khẩu.
    pub fn auto_unlock(&mut self) -> AppResult<()> {
        let status = self.status();
        if status.exists && !status.unlocked && !status.has_password {
            self.unlock(None)?;
        }
        Ok(())
    }

    /// Đặt, đổi hoặc bỏ master password (`new = None` là bỏ mật khẩu).
    /// Nếu vault đang có mật khẩu thì phải nhập đúng mật khẩu hiện tại.
    pub fn set_password(&mut self, current: Option<&str>, new: Option<&str>) -> AppResult<()> {
        let unlocked = self.unlocked_mut()?;
        if let Protection::Password(kdf) = &unlocked.protection {
            let current = current.ok_or_else(AppError::wrong_password)?;
            if kdf.derive_key(current)?.as_slice() != unlocked.key.as_slice() {
                return Err(AppError::wrong_password());
            }
        }
        let (key, protection) = Protection::generate(new)?;
        unlocked.key = key;
        unlocked.protection = protection;
        self.save()
    }

    pub fn lock(&mut self) {
        self.unlocked = None;
    }

    /// Nội dung bản sao lưu:
    /// - vault có master password: nguyên file vault (đã mã hoá).
    /// - vault không mật khẩu: key do DPAPI giữ, không mang sang máy khác được, nên sao lưu
    ///   danh sách tài khoản dạng JSON không mã hoá (chỉ được bảo vệ bởi tài khoản Google).
    pub fn backup_bytes(&self) -> AppResult<Vec<u8>> {
        if !self.path.exists() {
            return Err(AppError::no_vault());
        }
        if self.read_file()?.kdf.is_some() {
            return Ok(fs::read(&self.path)?);
        }
        let backup = PlainBackup {
            format: PLAIN_BACKUP_FORMAT.into(),
            version: 1,
            accounts: self.unlocked()?.accounts.clone(),
        };
        Ok(serde_json::to_vec_pretty(&backup)?)
    }

    /// Thay vault trên máy bằng bản sao lưu. Vault cũ (nếu có) được giữ ở `vault.json.bak`.
    /// - Bản mã hoá: vault bị khoá, mở bằng master password của bản sao lưu.
    /// - Bản JSON không mã hoá: tạo vault không mật khẩu, mở khoá luôn.
    pub fn restore_backup(&mut self, bytes: &[u8]) -> AppResult<()> {
        let invalid = || AppError::new("INVALID_BACKUP", "Bản sao lưu không hợp lệ.");
        let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;

        if value["format"] == PLAIN_BACKUP_FORMAT {
            let backup: PlainBackup = serde_json::from_value(value).map_err(|_| invalid())?;
            self.keep_previous_vault()?;
            let (key, protection) = Protection::generate(None)?;
            self.unlocked = Some(Unlocked {
                key,
                protection,
                accounts: backup.accounts,
            });
            return self.save();
        }

        let file: VaultFile = serde_json::from_value(value).map_err(|_| invalid())?;
        if file.version != FILE_VERSION || file.kdf.is_none() {
            return Err(invalid());
        }
        self.keep_previous_vault()?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, bytes)?;
        fs::rename(&tmp, &self.path)?;
        self.lock();
        Ok(())
    }

    fn keep_previous_vault(&self) -> AppResult<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        if self.path.exists() {
            fs::copy(&self.path, self.path.with_extension("json.bak"))?;
        }
        Ok(())
    }

    fn read_file(&self) -> AppResult<VaultFile> {
        Ok(serde_json::from_slice(&fs::read(&self.path)?)?)
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
        self.import(vec![new])?
            .added
            .into_iter()
            .next()
            .ok_or_else(|| AppError::invalid_account("Tài khoản này đã tồn tại."))
    }

    /// Thêm nhiều tài khoản cùng lúc, bỏ qua tài khoản trùng secret. Chỉ ghi file một lần.
    pub fn import(&mut self, accounts: Vec<NewAccount>) -> AppResult<ImportResult> {
        self.unlocked()?;
        let accounts = accounts
            .into_iter()
            .map(build_account)
            .collect::<AppResult<Vec<_>>>()?;

        let unlocked = self.unlocked_mut()?;
        let mut result = ImportResult::default();
        for account in accounts {
            if unlocked.accounts.iter().any(|a| a.secret == account.secret) {
                result.duplicates += 1;
                continue;
            }
            result.added.push(AccountSummary {
                id: account.id.clone(),
                issuer: account.issuer.clone(),
                label: account.label.clone(),
            });
            unlocked.accounts.push(account);
        }
        if !result.added.is_empty() {
            self.save()?;
        }
        Ok(result)
    }

    /// Xem trước các tài khoản sẽ được import (không lưu, không trả secret).
    pub fn preview_uri(&self, input: &str) -> AppResult<ImportPreview> {
        let existing = &self.unlocked()?.accounts;
        let parsed = otpauth::parse_many(input)?;
        let mut seen: Vec<String> = Vec::new();
        let mut accounts = Vec::new();
        for new in parsed.accounts {
            let account = build_account(new)?;
            let duplicate = existing.iter().any(|a| a.secret == account.secret)
                || seen.contains(&account.secret);
            seen.push(account.secret.clone());
            accounts.push(AccountPreview {
                issuer: account.issuer,
                label: account.label,
                algorithm: account.algorithm,
                digits: account.digits,
                period: account.period,
                duplicate,
            });
        }
        Ok(ImportPreview {
            accounts,
            unsupported: parsed.unsupported,
        })
    }

    /// Import từ `otpauth://` hoặc `otpauth-migration://` (có thể nhiều link, mỗi link một dòng).
    pub fn import_uri(&mut self, input: &str) -> AppResult<ImportResult> {
        let parsed = otpauth::parse_many(input)?;
        if parsed.accounts.is_empty() {
            return Err(AppError::invalid_uri(
                "Không có tài khoản TOTP nào để import (HOTP chưa được hỗ trợ).",
            ));
        }
        let mut result = self.import(parsed.accounts)?;
        result.unsupported = parsed.unsupported;
        if result.added.is_empty() {
            return Err(AppError::invalid_account("Tất cả tài khoản đã tồn tại."));
        }
        Ok(result)
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

        let (kdf, device_key) = match &unlocked.protection {
            Protection::Password(kdf) => (Some(kdf.clone()), None),
            Protection::Device(wrapped) => (None, Some(wrapped.clone())),
        };
        let file = VaultFile {
            version: FILE_VERSION,
            kdf,
            device_key,
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

fn check_password(password: &str) -> AppResult<()> {
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(AppError::new(
            "WEAK_PASSWORD",
            format!("Mật khẩu cần ít nhất {MIN_PASSWORD_LEN} ký tự."),
        ));
    }
    Ok(())
}

fn build_account(new: NewAccount) -> AppResult<Account> {
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
    Ok(Account {
        id: uuid::Uuid::new_v4().to_string(),
        issuer,
        label,
        secret,
        algorithm: new.algorithm,
        digits: new.digits,
        period: new.period,
        created_at: now_ms(),
    })
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
        vault.create(Some("correct horse")).unwrap();
        vault.add(sample()).unwrap();
        vault.lock();
        assert!(matches!(vault.codes(), Err(e) if e.code == "LOCKED"));

        assert_eq!(vault.unlock(Some("wrong password")).unwrap_err().code, "WRONG_PASSWORD");
        vault.unlock(Some("correct horse")).unwrap();
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
        vault.create(Some("correct horse")).unwrap();
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
    fn import_uri_skips_duplicates() {
        let mut vault = temp_vault();
        vault.create(Some("correct horse")).unwrap();
        let input = "otpauth://totp/a?secret=JBSWY3DPEHPK3PXP\notpauth://totp/b?secret=GEZDGNBVGY3TQOJQ";

        let result = vault.import_uri(input).unwrap();
        assert_eq!(result.added.len(), 2);
        assert_eq!(result.duplicates, 0);
        assert_eq!(vault.import_uri(input).unwrap_err().code, "INVALID_ACCOUNT");

        let result = vault
            .import_uri("otpauth://totp/a?secret=JBSWY3DPEHPK3PXP otpauth://totp/c?secret=MFRGGZDFMZTWQ2LK")
            .unwrap();
        assert_eq!(result.added.len(), 1);
        assert_eq!(result.added[0].label, "c");
        assert_eq!(result.duplicates, 1);
        assert_eq!(vault.codes().unwrap().len(), 3);
        let _ = fs::remove_dir_all(vault.path.parent().unwrap());
    }

    #[test]
    fn rejects_short_password() {
        let mut vault = temp_vault();
        assert_eq!(vault.create(Some("short")).unwrap_err().code, "WEAK_PASSWORD");
    }

    #[test]
    fn preview_marks_duplicates_without_saving() {
        let mut vault = temp_vault();
        vault.create(Some("correct horse")).unwrap();
        vault.import_uri("otpauth://totp/GitHub:a?secret=JBSWY3DPEHPK3PXP&issuer=GitHub").unwrap();

        let preview = vault
            .preview_uri(
                "otpauth://totp/GitHub:a?secret=JBSWY3DPEHPK3PXP&issuer=GitHub\n\
                 otpauth://totp/b?secret=GEZDGNBVGY3TQOJQ&digits=8\n\
                 otpauth://totp/b-again?secret=GEZDGNBVGY3TQOJQ",
            )
            .unwrap();
        let summary: Vec<_> = preview
            .accounts
            .iter()
            .map(|a| (a.label.as_str(), a.digits, a.duplicate))
            .collect();
        assert_eq!(summary, [("a", 6, true), ("b", 8, false), ("b-again", 6, true)]);
        assert_eq!(vault.codes().unwrap().len(), 1, "preview không được lưu");
        let _ = fs::remove_dir_all(vault.path.parent().unwrap());
    }

    #[test]
    fn backup_and_restore_roundtrip() {
        let mut source = temp_vault();
        source.create(Some("correct horse")).unwrap();
        source.add(sample()).unwrap();
        let backup = source.backup_bytes().unwrap();

        // Máy mới đã có vault khác: khôi phục thì vault cũ được giữ ở .bak.
        let mut target = temp_vault();
        target.create(Some("other password")).unwrap();
        target.restore_backup(&backup).unwrap();
        assert!(!target.status().unlocked);
        assert!(target.path.with_extension("json.bak").exists());
        assert_eq!(target.unlock(Some("other password")).unwrap_err().code, "WRONG_PASSWORD");
        target.unlock(Some("correct horse")).unwrap();
        assert_eq!(target.codes().unwrap()[0].issuer, "GitHub");

        assert_eq!(target.restore_backup(b"{}").unwrap_err().code, "INVALID_BACKUP");
        let _ = fs::remove_dir_all(source.path.parent().unwrap());
        let _ = fs::remove_dir_all(target.path.parent().unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn passwordless_backup_restores_without_password() {
        let mut source = temp_vault();
        source.create(None).unwrap();
        source.add(sample()).unwrap();
        let backup = source.backup_bytes().unwrap();
        let json: serde_json::Value = serde_json::from_slice(&backup).unwrap();
        assert_eq!(json["format"], PLAIN_BACKUP_FORMAT);
        assert_eq!(json["accounts"][0]["issuer"], "GitHub");

        // Máy mới (vault có mật khẩu): khôi phục xong là vault không mật khẩu, mở sẵn.
        let mut target = temp_vault();
        target.create(Some("other password")).unwrap();
        target.restore_backup(&backup).unwrap();
        let status = target.status();
        assert!(status.unlocked && !status.has_password);
        assert_eq!(target.codes().unwrap()[0].issuer, "GitHub");
        assert!(target.path.with_extension("json.bak").exists());

        let mut reopened = Vault::new(target.path.clone());
        reopened.auto_unlock().unwrap();
        assert_eq!(reopened.codes().unwrap().len(), 1);
        let _ = fs::remove_dir_all(source.path.parent().unwrap());
        let _ = fs::remove_dir_all(target.path.parent().unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn passwordless_vault_auto_unlocks() {
        let mut vault = temp_vault();
        vault.create(None).unwrap();
        vault.add(sample()).unwrap();
        assert!(!vault.status().has_password);

        // Mở lại như lúc khởi động app: không cần mật khẩu.
        let mut reopened = Vault::new(vault.path.clone());
        let status = reopened.status();
        assert!(status.exists && !status.unlocked && !status.has_password);
        reopened.auto_unlock().unwrap();
        assert_eq!(reopened.codes().unwrap().len(), 1);
        let _ = fs::remove_dir_all(vault.path.parent().unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn set_and_remove_password() {
        let mut vault = temp_vault();
        vault.create(None).unwrap();
        vault.add(sample()).unwrap();

        // Không mật khẩu -> đặt mật khẩu: không cần mật khẩu cũ.
        vault.set_password(None, Some("correct horse")).unwrap();
        let mut reopened = Vault::new(vault.path.clone());
        assert!(reopened.status().has_password);
        reopened.auto_unlock().unwrap();
        assert!(!reopened.status().unlocked);
        reopened.unlock(Some("correct horse")).unwrap();

        // Đổi mật khẩu: phải đúng mật khẩu hiện tại.
        let err = reopened.set_password(Some("wrong password"), Some("battery staple")).unwrap_err();
        assert_eq!(err.code, "WRONG_PASSWORD");
        reopened.set_password(Some("correct horse"), Some("battery staple")).unwrap();

        // Bỏ mật khẩu.
        reopened.set_password(Some("battery staple"), None).unwrap();
        let mut last = Vault::new(vault.path.clone());
        last.auto_unlock().unwrap();
        assert_eq!(last.codes().unwrap().len(), 1);
        let _ = fs::remove_dir_all(vault.path.parent().unwrap());
    }
}
