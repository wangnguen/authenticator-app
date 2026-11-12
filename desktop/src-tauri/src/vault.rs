//! Vault mã hoá AES-256-GCM. Key lấy từ một trong hai nguồn:
//! - có master password: key = Argon2id(password, salt)
//! - không có mật khẩu: key ngẫu nhiên, được Windows DPAPI khoá theo tài khoản Windows
//! Key chỉ nằm trong RAM khi vault đang mở và được xoá (zeroize) khi khoá.

use crate::dpapi;
use crate::error::{AppError, AppResult};
use crate::otpauth;
use crate::sync::{Merge, PendingDeletion, SyncSummary};
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

/// v1: nội dung giải mã là mảng tài khoản. v2: `{ accounts, deleted }` (thêm Thùng rác).
/// App bản cũ gặp v2 sẽ báo "phiên bản không hỗ trợ" thay vì đọc sai.
const FILE_VERSION: u32 = 2;
const MIN_FILE_VERSION: u32 = 1;
const AAD: &[u8] = b"authenticator-vault-v1";
pub const MIN_PASSWORD_LEN: usize = 8;
/// Số bản vault cũ giữ lại trong thư mục `history` (trước khi khôi phục/đồng bộ thay đổi vault).
const HISTORY_KEEP: usize = 10;

/// Base32 không padding, bỏ qua trailing bits (một số dịch vụ sinh secret như vậy).
static BASE32: LazyLock<Encoding> = LazyLock::new(|| {
    let mut spec = BASE32_NOPAD.specification();
    spec.check_trailing_bits = false;
    spec.encoding().expect("valid base32 spec")
});

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Account {
    pub(crate) id: String,
    pub(crate) issuer: String,
    pub(crate) label: String,
    /// Base32 đã chuẩn hoá (in hoa, không padding).
    pub(crate) secret: String,
    pub(crate) algorithm: Algorithm,
    pub(crate) digits: u32,
    pub(crate) period: u64,
    pub(crate) created_at: u64,
    /// Lần thay đổi cuối (khôi phục từ Thùng rác, giữ lại khi đồng bộ), Unix ms.
    /// Vault cũ không có trường này thì coi như bằng `created_at`.
    #[serde(default)]
    pub(crate) updated_at: u64,
}

impl Account {
    pub(crate) fn changed_at(&self) -> u64 {
        self.updated_at.max(self.created_at)
    }

    pub(crate) fn summary(&self) -> AccountSummary {
        AccountSummary {
            id: self.id.clone(),
            issuer: self.issuer.clone(),
            label: self.label.clone(),
        }
    }
}

/// Tài khoản đã xoá. Giữ `id` + thời điểm xoá để khi đồng bộ máy khác biết là "đã xoá" chứ
/// không phải "chưa có", và giữ cả dữ liệu tài khoản để khôi phục từ Thùng rác.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Deleted {
    pub(crate) id: String,
    pub(crate) deleted_at: u64,
    /// `None`: đã xoá vĩnh viễn, không còn secret.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) account: Option<Account>,
}

/// Nội dung đã giải mã của vault, cũng là nội dung của bản sao lưu.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct VaultData {
    pub(crate) accounts: Vec<Account>,
    #[serde(default)]
    pub(crate) deleted: Vec<Deleted>,
}

/// Nội dung giải mã: vault v1 là mảng tài khoản, v2 là [`VaultData`].
#[derive(Deserialize)]
#[serde(untagged)]
enum StoredData {
    Current(VaultData),
    Legacy(Vec<Account>),
}

impl From<StoredData> for VaultData {
    fn from(stored: StoredData) -> Self {
        match stored {
            StoredData::Current(data) => data,
            StoredData::Legacy(accounts) => Self {
                accounts,
                deleted: Vec::new(),
            },
        }
    }
}

/// Một mục trong Thùng rác (không có secret).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub id: String,
    pub issuer: String,
    pub label: String,
    /// Unix ms.
    pub deleted_at: u64,
}

/// Bản sao lưu đã đọc được.
pub enum Remote {
    /// Drive chưa có bản sao lưu.
    Missing,
    /// JSON không mã hoá (sao lưu từ vault không mật khẩu).
    Plain(VaultData),
    Encrypted {
        data: VaultData,
        key: Zeroizing<[u8; 32]>,
        kdf: KdfParams,
        /// Cùng master password và salt với vault trên máy.
        same_as_local: bool,
    },
}

impl Remote {
    fn data(&self) -> Option<&VaultData> {
        match self {
            Self::Missing => None,
            Self::Plain(data) | Self::Encrypted { data, .. } => Some(data),
        }
    }
}

/// Xem trước kết quả đồng bộ (không chứa secret).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPreview {
    /// Thời điểm sửa của bản sao lưu đã xem trước (`None`: chưa có bản nào).
    pub backup_version: Option<String>,
    pub backup_exists: bool,
    /// Máy này và Drive đã giống nhau, đồng bộ không thay đổi gì (tự đồng bộ thì bỏ qua).
    pub in_sync: bool,
    /// Tài khoản sẽ được thêm vào máy này.
    pub added: Vec<AccountSummary>,
    /// Tài khoản chỉ có trên máy này, sẽ được đưa lên bản sao lưu.
    pub uploaded: Vec<AccountSummary>,
    /// Tài khoản bị xoá ở một bên, chỉ xoá khi người dùng xác nhận.
    pub pending_deletions: Vec<PendingDeletion>,
    pub warnings: Vec<String>,
}

/// Xem trước khi khôi phục (thay toàn bộ vault trên máy bằng bản sao lưu).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    /// Thời điểm sửa của bản sao lưu đã so sánh, truyền lại khi khôi phục.
    pub backup_version: String,
    pub local_count: usize,
    /// `None`: bản sao lưu dùng master password khác, chưa đọc được.
    pub backup_count: Option<usize>,
    /// Tài khoản đang có trên máy nhưng không có trong bản sao lưu (sẽ mất khỏi danh sách).
    /// `None`: chưa đọc được bản sao lưu nên không so sánh được.
    pub missing: Option<Vec<AccountSummary>>,
    pub warnings: Vec<String>,
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
    #[serde(flatten)]
    data: VaultData,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfParams {
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

    fn supported(&self) -> bool {
        (MIN_FILE_VERSION..=FILE_VERSION).contains(&self.version)
    }

    /// Mã hoá dữ liệu thành file vault (nonce mới mỗi lần).
    fn seal(data: &VaultData, key: &[u8; 32], protection: &Protection) -> AppResult<Self> {
        let plaintext = Zeroizing::new(serde_json::to_vec(data)?);
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let cipher = Aes256Gcm::new_from_slice(key).map_err(AppError::internal)?;
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &plaintext,
                    aad: AAD,
                },
            )
            .map_err(AppError::internal)?;
        let (kdf, device_key) = match protection {
            Protection::Password(kdf) => (Some(kdf.clone()), None),
            Protection::Device(wrapped) => (None, Some(wrapped.clone())),
        };
        Ok(Self {
            version: FILE_VERSION,
            kdf,
            device_key,
            nonce: BASE64.encode(&nonce),
            ciphertext: BASE64.encode(&ciphertext),
        })
    }

    /// Giải mã. Sai key thì trả `WRONG_PASSWORD`.
    fn open(&self, key: &[u8; 32]) -> AppResult<VaultData> {
        let nonce = BASE64.decode(self.nonce.as_bytes()).map_err(AppError::internal)?;
        let ciphertext = BASE64
            .decode(self.ciphertext.as_bytes())
            .map_err(AppError::internal)?;
        if nonce.len() != 12 {
            return Err(AppError::internal("Nonce không hợp lệ."));
        }
        let cipher = Aes256Gcm::new_from_slice(key).map_err(AppError::internal)?;
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
        Ok(serde_json::from_slice::<StoredData>(&plaintext)?.into())
    }
}

/// Bản sao lưu chưa giải mã.
enum Backup {
    Plain(VaultData),
    Encrypted(VaultFile),
}

fn invalid_backup() -> AppError {
    AppError::new("INVALID_BACKUP", "Bản sao lưu không hợp lệ.")
}

fn parse_backup(bytes: &[u8]) -> AppResult<Backup> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| invalid_backup())?;
    if value["format"] == PLAIN_BACKUP_FORMAT {
        let backup: PlainBackup = serde_json::from_value(value).map_err(|_| invalid_backup())?;
        return Ok(Backup::Plain(backup.data));
    }
    let file: VaultFile = serde_json::from_value(value).map_err(|_| invalid_backup())?;
    if file.kdf.is_none() {
        return Err(invalid_backup());
    }
    if !file.supported() {
        return Err(AppError::new(
            "INVALID_BACKUP",
            "Bản sao lưu được tạo bởi phiên bản app mới hơn. Hãy cập nhật app.",
        ));
    }
    Ok(Backup::Encrypted(file))
}

struct Unlocked {
    key: Zeroizing<[u8; 32]>,
    protection: Protection,
    data: VaultData,
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
            data: VaultData::default(),
        });
        self.save()
    }

    /// Mở khoá vault. Vault không có mật khẩu thì bỏ qua `password`.
    pub fn unlock(&mut self, password: Option<&str>) -> AppResult<()> {
        if !self.path.exists() {
            return Err(AppError::no_vault());
        }
        let file = self.read_file()?;
        if !file.supported() {
            return Err(AppError::internal(format!(
                "Phiên bản vault không hỗ trợ: {}. Hãy cập nhật app.",
                file.version
            )));
        }
        let protection = file.protection()?;
        let key = protection.key(password)?;
        let data = file.open(&key)?;
        self.unlocked = Some(Unlocked {
            key,
            protection,
            data,
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

    /// Nội dung bản sao lưu theo cách bảo vệ của vault trên máy:
    /// - vault có master password: file vault đã mã hoá.
    /// - vault không mật khẩu: key do DPAPI giữ, không mang sang máy khác được, nên sao lưu
    ///   danh sách tài khoản dạng JSON không mã hoá (chỉ được bảo vệ bởi tài khoản Google).
    pub fn backup_bytes(&self) -> AppResult<Vec<u8>> {
        let unlocked = self.unlocked()?;
        match &unlocked.protection {
            Protection::Password(_) => {
                let file = VaultFile::seal(&unlocked.data, &unlocked.key, &unlocked.protection)?;
                Ok(serde_json::to_vec_pretty(&file)?)
            }
            Protection::Device(_) => {
                let backup = PlainBackup {
                    format: PLAIN_BACKUP_FORMAT.into(),
                    version: 1,
                    data: unlocked.data.clone(),
                };
                Ok(serde_json::to_vec_pretty(&backup)?)
            }
        }
    }

    /// Đọc bản sao lưu (`None`: Drive chưa có bản nào).
    /// Bản mã hoá cùng master password và salt với máy này thì dùng luôn key đang mở; khác thì
    /// cần `password` của bản sao lưu, thiếu thì trả lỗi `BACKUP_PASSWORD`.
    pub fn read_remote(&self, bytes: Option<&[u8]>, password: Option<&str>) -> AppResult<Remote> {
        let Some(bytes) = bytes else {
            return Ok(Remote::Missing);
        };
        let unlocked = self.unlocked()?;
        let file = match parse_backup(bytes)? {
            Backup::Plain(data) => return Ok(Remote::Plain(data)),
            Backup::Encrypted(file) => file,
        };
        let kdf = file.kdf.clone().ok_or_else(invalid_backup)?;
        if let Protection::Password(local) = &unlocked.protection {
            if *local == kdf {
                if let Ok(data) = file.open(&unlocked.key) {
                    return Ok(Remote::Encrypted {
                        data,
                        key: unlocked.key.clone(),
                        kdf,
                        same_as_local: true,
                    });
                }
            }
        }
        let password = password.ok_or_else(|| {
            AppError::new(
                "BACKUP_PASSWORD",
                "Bản sao lưu trên Drive dùng master password khác với máy này. Nhập master password của bản sao lưu.",
            )
        })?;
        let key = kdf.derive_key(password)?;
        let data = file.open(&key).map_err(|e| {
            if e.code == "WRONG_PASSWORD" {
                AppError::new("WRONG_PASSWORD", "Sai master password của bản sao lưu.")
            } else {
                e
            }
        })?;
        Ok(Remote::Encrypted {
            data,
            key,
            kdf,
            same_as_local: false,
        })
    }

    /// Xem trước kết quả đồng bộ, không thay đổi gì. `backup_version` được trả lại cho
    /// `google_sync` để chắc chắn áp dụng đúng bản sao lưu người dùng đã xem.
    pub fn sync_preview(
        &self,
        remote: &Remote,
        password: Option<&str>,
        backup_version: Option<String>,
    ) -> AppResult<SyncPreview> {
        let unlocked = self.unlocked()?;
        let empty = VaultData::default();
        let merge = Merge::compute(&unlocked.data, remote.data().unwrap_or(&empty));
        let pending_deletions = merge.pending();
        let added = merge.added.clone();
        let uploaded = merge.uploaded.clone();
        let in_sync = pending_deletions.is_empty() && {
            let (merged, _) = merge.resolve(&[], now_ms());
            self.in_sync(remote, &merged)?
        };
        let mut warnings = Vec::new();
        if let (Protection::Password(_), Remote::Encrypted { same_as_local: false, .. }) =
            (&unlocked.protection, remote)
        {
            if self.shared_key(remote, password)?.is_none() {
                warnings.push(
                    "Bản sao lưu đang dùng master password khác. Sau khi đồng bộ, bản sao lưu sẽ dùng master password của máy này."
                        .into(),
                );
            }
        }
        Ok(SyncPreview {
            backup_version,
            backup_exists: !matches!(remote, Remote::Missing),
            in_sync,
            added,
            uploaded,
            pending_deletions,
            warnings,
        })
    }

    /// Gộp bản sao lưu vào vault trên máy, trả nội dung cần tải lên Drive.
    /// Chỉ xoá các tài khoản có id trong `confirmed`; vault trước khi đổi được giữ trong `history`.
    pub fn sync_apply(
        &mut self,
        remote: &Remote,
        confirmed: &[String],
        password: Option<&str>,
    ) -> AppResult<(SyncSummary, Vec<u8>)> {
        let shared_key = self.shared_key(remote, password)?;
        let unlocked = self.unlocked()?;
        let empty = VaultData::default();
        let (data, summary) = Merge::compute(&unlocked.data, remote.data().unwrap_or(&empty))
            .resolve(confirmed, now_ms());
        let changed = !same_data(&data, &unlocked.data)?;

        if changed || shared_key.is_some() {
            self.snapshot()?;
            let unlocked = self.unlocked_mut()?;
            unlocked.data = data;
            if let Some((key, kdf)) = shared_key {
                unlocked.key = key;
                unlocked.protection = Protection::Password(kdf);
            }
            self.save()?;
        }
        Ok((summary, self.upload_bytes(remote)?))
    }

    /// Kết quả gộp giống hệt cả vault trên máy lẫn bản trên Drive, và bản trên Drive đã được bảo
    /// vệ đúng như khi tải lên (vault có mật khẩu thì bản trên Drive dùng cùng key).
    fn in_sync(&self, remote: &Remote, merged: &VaultData) -> AppResult<bool> {
        let unlocked = self.unlocked()?;
        let local = &unlocked.data;
        let protected = match (&unlocked.protection, remote) {
            (_, Remote::Missing) => {
                return Ok(local.accounts.is_empty() && local.deleted.is_empty());
            }
            (Protection::Password(_), Remote::Encrypted { same_as_local, .. }) => *same_as_local,
            (Protection::Password(_), Remote::Plain(_)) => false,
            (Protection::Device(_), _) => true,
        };
        let Some(remote_data) = remote.data() else {
            return Ok(false);
        };
        Ok(protected && same_data(merged, local)? && same_data(merged, remote_data)?)
    }

    /// Hai máy đặt cùng master password nhưng khác salt: trả key + salt của bản sao lưu để máy
    /// này dùng chung, lần đồng bộ sau không phải nhập lại mật khẩu.
    fn shared_key(
        &self,
        remote: &Remote,
        password: Option<&str>,
    ) -> AppResult<Option<(Zeroizing<[u8; 32]>, KdfParams)>> {
        let unlocked = self.unlocked()?;
        if let (
            Remote::Encrypted {
                key,
                kdf,
                same_as_local: false,
                ..
            },
            Protection::Password(local),
            Some(password),
        ) = (remote, &unlocked.protection, password)
        {
            if local.derive_key(password)?.as_slice() == unlocked.key.as_slice() {
                return Ok(Some((key.clone(), kdf.clone())));
            }
        }
        Ok(None)
    }

    /// Nội dung tải lên khi đồng bộ. Vault không mật khẩu mà bản trên Drive đang mã hoá thì vẫn
    /// mã hoá bằng key của bản đó, không hạ xuống JSON không mã hoá.
    fn upload_bytes(&self, remote: &Remote) -> AppResult<Vec<u8>> {
        let unlocked = self.unlocked()?;
        match (&unlocked.protection, remote) {
            (Protection::Device(_), Remote::Encrypted { key, kdf, .. }) => {
                let file = VaultFile::seal(&unlocked.data, key, &Protection::Password(kdf.clone()))?;
                Ok(serde_json::to_vec_pretty(&file)?)
            }
            _ => self.backup_bytes(),
        }
    }

    /// So sánh vault trên máy với bản sao lưu trước khi khôi phục (thay toàn bộ).
    pub fn restore_preview(&self, bytes: &[u8], backup_version: String) -> AppResult<RestorePreview> {
        let unlocked = self.unlocked()?;
        let has_password = matches!(unlocked.protection, Protection::Password(_));
        let mut warnings: Vec<String> = Vec::new();
        let backup = match (parse_backup(bytes)?, has_password) {
            (Backup::Plain(data), true) => {
                warnings.push(
                    "Bản sao lưu không mã hoá: sau khi khôi phục, vault sẽ không còn master password."
                        .into(),
                );
                Some(data)
            }
            (Backup::Plain(data), false) => Some(data),
            // Vault không mật khẩu không có key để đọc bản mã hoá, nên không so sánh được.
            (Backup::Encrypted(_), false) => {
                warnings.push(
                    "Bản sao lưu được mã hoá: sau khi khôi phục, vault dùng master password của bản sao lưu và phải nhập mỗi lần mở app."
                        .into(),
                );
                None
            }
            (Backup::Encrypted(_), true) => match self.read_remote(Some(bytes), None) {
                Ok(remote) => remote.data().cloned(),
                Err(e) if e.code == "BACKUP_PASSWORD" => {
                    warnings.push(
                        "Bản sao lưu dùng master password khác: sau khi khôi phục phải mở vault bằng master password của bản sao lưu."
                            .into(),
                    );
                    None
                }
                Err(e) => return Err(e),
            },
        };
        let missing = backup.as_ref().map(|backup| {
            unlocked
                .data
                .accounts
                .iter()
                .filter(|a| !backup.accounts.iter().any(|b| b.secret == a.secret))
                .map(Account::summary)
                .collect()
        });
        Ok(RestorePreview {
            backup_version,
            local_count: unlocked.data.accounts.len(),
            backup_count: backup.map(|b| b.accounts.len()),
            missing,
            warnings,
        })
    }

    /// Thay vault trên máy bằng bản sao lưu. Vault cũ (nếu có) được giữ trong thư mục `history`.
    /// - Bản mã hoá: vault bị khoá, mở bằng master password của bản sao lưu.
    /// - Bản JSON không mã hoá: tạo vault không mật khẩu, mở khoá luôn.
    pub fn restore_backup(&mut self, bytes: &[u8]) -> AppResult<()> {
        match parse_backup(bytes)? {
            Backup::Plain(data) => {
                self.snapshot()?;
                let (key, protection) = Protection::generate(None)?;
                self.unlocked = Some(Unlocked {
                    key,
                    protection,
                    data,
                });
                self.save()
            }
            Backup::Encrypted(_) => {
                self.snapshot()?;
                if let Some(dir) = self.path.parent() {
                    fs::create_dir_all(dir)?;
                }
                let tmp = self.path.with_extension("json.tmp");
                fs::write(&tmp, bytes)?;
                fs::rename(&tmp, &self.path)?;
                self.lock();
                Ok(())
            }
        }
    }

    /// Thư mục chứa các bản vault cũ, cạnh file vault.
    pub fn history_dir(&self) -> PathBuf {
        self.path.with_file_name("history")
    }

    /// Lưu bản sao file vault hiện tại vào `history/` và chỉ giữ `HISTORY_KEEP` bản mới nhất.
    fn snapshot(&self) -> AppResult<()> {
        if !self.path.exists() {
            return Ok(());
        }
        let dir = self.history_dir();
        fs::create_dir_all(&dir)?;
        fs::copy(&self.path, dir.join(format!("vault-{}.json", now_ms())))?;

        let mut files: Vec<PathBuf> = fs::read_dir(&dir)?
            .filter_map(|entry| entry.ok().map(|e| e.path()))
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("vault-") && name.ends_with(".json"))
            })
            .collect();
        // Tên theo Unix ms cùng số chữ số nên sắp theo tên là theo thời gian.
        files.sort();
        let excess = files.len().saturating_sub(HISTORY_KEEP);
        for old in &files[..excess] {
            let _ = fs::remove_file(old);
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
            .data
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
            if unlocked.data.accounts.iter().any(|a| a.secret == account.secret) {
                result.duplicates += 1;
                continue;
            }
            result.added.push(AccountSummary {
                id: account.id.clone(),
                issuer: account.issuer.clone(),
                label: account.label.clone(),
            });
            unlocked.data.accounts.push(account);
        }
        if !result.added.is_empty() {
            self.save()?;
        }
        Ok(result)
    }

    /// Xem trước các tài khoản sẽ được import (không lưu, không trả secret).
    pub fn preview_uri(&self, input: &str) -> AppResult<ImportPreview> {
        let existing = &self.unlocked()?.data.accounts;
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

    /// Chuyển tài khoản vào Thùng rác (khôi phục được, và đồng bộ báo cho máy khác là đã xoá).
    pub fn remove(&mut self, id: &str) -> AppResult<()> {
        let unlocked = self.unlocked_mut()?;
        let index = unlocked
            .data
            .accounts
            .iter()
            .position(|a| a.id == id)
            .ok_or_else(AppError::not_found)?;
        let account = unlocked.data.accounts.remove(index);
        unlocked.data.deleted.retain(|d| d.id != id);
        unlocked.data.deleted.push(Deleted {
            id: account.id.clone(),
            deleted_at: now_ms(),
            account: Some(account),
        });
        self.save()
    }

    /// Các tài khoản trong Thùng rác, mới xoá trước.
    pub fn trash(&self) -> AppResult<Vec<TrashEntry>> {
        let mut entries: Vec<TrashEntry> = self
            .unlocked()?
            .data
            .deleted
            .iter()
            .filter_map(|d| {
                d.account.as_ref().map(|a| TrashEntry {
                    id: d.id.clone(),
                    issuer: a.issuer.clone(),
                    label: a.label.clone(),
                    deleted_at: d.deleted_at,
                })
            })
            .collect();
        entries.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
        Ok(entries)
    }

    /// Lấy tài khoản ra khỏi Thùng rác. Thời điểm thay đổi mới hơn lúc xoá nên khi đồng bộ,
    /// các máy khác cũng có lại tài khoản này.
    pub fn restore_deleted(&mut self, id: &str) -> AppResult<AccountSummary> {
        let unlocked = self.unlocked_mut()?;
        let index = unlocked
            .data
            .deleted
            .iter()
            .position(|d| d.id == id && d.account.is_some())
            .ok_or_else(AppError::not_found)?;
        let Some(mut account) = unlocked.data.deleted[index].account.clone() else {
            return Err(AppError::not_found());
        };
        if unlocked.data.accounts.iter().any(|a| a.secret == account.secret) {
            return Err(AppError::invalid_account(
                "Tài khoản này đã có trong danh sách (có thể đã được thêm lại).",
            ));
        }
        unlocked.data.deleted.remove(index);
        account.updated_at = now_ms();
        let summary = account.summary();
        unlocked.data.accounts.push(account);
        self.save()?;
        Ok(summary)
    }

    /// Xoá vĩnh viễn khỏi Thùng rác: bỏ secret, chỉ giữ id + thời điểm xoá để đồng bộ.
    /// Các bản vault cũ trong `history/` (và bản trên Drive cho tới lần đồng bộ sau) vẫn còn.
    pub fn purge_deleted(&mut self, id: &str) -> AppResult<()> {
        let unlocked = self.unlocked_mut()?;
        let entry = unlocked
            .data
            .deleted
            .iter_mut()
            .find(|d| d.id == id && d.account.is_some())
            .ok_or_else(AppError::not_found)?;
        entry.account = None;
        self.save()
    }

    fn save(&self) -> AppResult<()> {
        let unlocked = self.unlocked()?;
        let file = VaultFile::seal(&unlocked.data, &unlocked.key, &unlocked.protection)?;

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

/// Kết quả gộp (đã sắp theo id) có giống `other` không, bỏ qua thứ tự của `other`.
fn same_data(merged: &VaultData, other: &VaultData) -> AppResult<bool> {
    let mut other = other.clone();
    other.accounts.sort_by(|a, b| a.id.cmp(&b.id));
    other.deleted.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(serde_json::to_vec(merged)? == serde_json::to_vec(&other)?)
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
    let now = now_ms();
    Ok(Account {
        id: uuid::Uuid::new_v4().to_string(),
        issuer,
        label,
        secret,
        algorithm: new.algorithm,
        digits: new.digits,
        period: new.period,
        created_at: now,
        updated_at: now,
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

    fn history_len(vault: &Vault) -> usize {
        fs::read_dir(vault.history_dir()).map(|d| d.count()).unwrap_or(0)
    }

    fn account_with(secret: &str) -> NewAccount {
        NewAccount {
            issuer: format!("Issuer {secret}"),
            secret: secret.into(),
            ..NewAccount::default()
        }
    }

    fn cleanup(vaults: &[&Vault]) {
        for vault in vaults {
            let _ = fs::remove_dir_all(vault.path.parent().unwrap());
        }
    }

    /// Đồng bộ như command `google_sync`, với "Drive" là một mảng byte.
    fn sync(vault: &mut Vault, drive: &mut Option<Vec<u8>>, confirmed: &[String]) -> SyncSummary {
        let remote = vault.read_remote(drive.as_deref(), None).unwrap();
        let (summary, bytes) = vault.sync_apply(&remote, confirmed, None).unwrap();
        *drive = Some(bytes);
        summary
    }

    #[test]
    fn two_devices_sync_without_losing_accounts() {
        let mut a = temp_vault();
        a.create(Some("correct horse")).unwrap();
        a.add(account_with("AAAAAAAA")).unwrap();
        let mut drive = None;
        assert_eq!(sync(&mut a, &mut drive, &[]).uploaded, 1);

        // Máy B khôi phục từ Drive, rồi mỗi máy thêm một tài khoản riêng.
        let mut b = temp_vault();
        b.restore_backup(drive.as_ref().unwrap()).unwrap();
        b.unlock(Some("correct horse")).unwrap();
        b.add(account_with("BBBBBBBB")).unwrap();
        a.add(account_with("CCCCCCCC")).unwrap();

        sync(&mut b, &mut drive, &[]);
        let summary = sync(&mut a, &mut drive, &[]);
        assert_eq!((summary.added, summary.uploaded), (1, 1));
        sync(&mut b, &mut drive, &[]);
        assert_eq!(a.codes().unwrap().len(), 3);
        assert_eq!(b.codes().unwrap().len(), 3);
        let remote = a.read_remote(drive.as_deref(), None).unwrap();
        assert!(a.sync_preview(&remote, None, None).unwrap().in_sync);
        b.add(account_with("DDDDDDDD")).unwrap();
        let remote = b.read_remote(drive.as_deref(), None).unwrap();
        assert!(!b.sync_preview(&remote, None, None).unwrap().in_sync);
        sync(&mut b, &mut drive, &[]);
        sync(&mut a, &mut drive, &[]);
        let id = b.codes().unwrap().iter().find(|c| c.issuer == "Issuer DDDDDDDD").unwrap().id.clone();
        b.remove(&id).unwrap();
        sync(&mut b, &mut drive, std::slice::from_ref(&id));
        sync(&mut a, &mut drive, std::slice::from_ref(&id));

        // B xoá một tài khoản: A không tự xoá mà chờ xác nhận.
        let removed = b.codes().unwrap()[0].id.clone();
        b.remove(&removed).unwrap();
        // Xoá trên máy này cũng hiện trong danh sách xác nhận khi đồng bộ.
        let remote = b.read_remote(drive.as_deref(), None).unwrap();
        assert_eq!(b.sync_preview(&remote, None, None).unwrap().pending_deletions.len(), 1);
        sync(&mut b, &mut drive, std::slice::from_ref(&removed));
        let remote = a.read_remote(drive.as_deref(), None).unwrap();
        let preview = a.sync_preview(&remote, None, None).unwrap();
        assert_eq!(preview.pending_deletions.len(), 1);
        assert_eq!(preview.pending_deletions[0].id, removed);

        // Không xác nhận: A giữ lại, và B cũng có lại sau lần đồng bộ sau.
        assert_eq!(sync(&mut a, &mut drive, &[]).kept, 1);
        assert_eq!(a.codes().unwrap().len(), 3);
        sync(&mut b, &mut drive, &[]);
        assert_eq!(b.codes().unwrap().len(), 3);

        // Xoá lại và lần này xác nhận: tài khoản nằm trong Thùng rác, khôi phục được.
        b.remove(&removed).unwrap();
        sync(&mut b, &mut drive, std::slice::from_ref(&removed));
        assert_eq!(sync(&mut a, &mut drive, std::slice::from_ref(&removed)).deleted, 1);
        assert_eq!(a.codes().unwrap().len(), 2);
        assert!(history_len(&a) >= 1, "vault trước khi xoá được lưu trong history");
        assert_eq!(a.trash().unwrap()[0].id, removed);
        a.restore_deleted(&removed).unwrap();
        sync(&mut a, &mut drive, &[]);
        sync(&mut b, &mut drive, &[]);
        assert_eq!(b.codes().unwrap().len(), 3);
        cleanup(&[&a, &b]);
    }

    #[test]
    fn sync_with_backup_of_other_password() {
        let mut a = temp_vault();
        a.create(Some("correct horse")).unwrap();
        a.add(account_with("AAAAAAAA")).unwrap();
        let drive = a.backup_bytes().unwrap();

        let mut b = temp_vault();
        b.create(Some("battery staple")).unwrap();
        b.add(account_with("BBBBBBBB")).unwrap();
        let err = b.read_remote(Some(&drive), None).err().unwrap();
        assert_eq!(err.code, "BACKUP_PASSWORD");
        let err = b.read_remote(Some(&drive), Some("wrong pass")).err().unwrap();
        assert_eq!(err.code, "WRONG_PASSWORD");

        let remote = b.read_remote(Some(&drive), Some("correct horse")).unwrap();
        assert_eq!(b.sync_preview(&remote, Some("correct horse"), None).unwrap().warnings.len(), 1);
        let (_, uploaded) = b.sync_apply(&remote, &[], Some("correct horse")).unwrap();
        assert_eq!(b.codes().unwrap().len(), 2);
        // Bản tải lên dùng master password của máy B.
        let mut check = temp_vault();
        check.restore_backup(&uploaded).unwrap();
        check.unlock(Some("battery staple")).unwrap();
        assert_eq!(check.codes().unwrap().len(), 2);
        cleanup(&[&a, &b, &check]);
    }

    #[test]
    fn same_password_on_two_devices_shares_key_after_first_sync() {
        let mut a = temp_vault();
        a.create(Some("correct horse")).unwrap();
        let drive = a.backup_bytes().unwrap();

        let mut b = temp_vault();
        b.create(Some("correct horse")).unwrap();
        // Khác salt nên lần đầu cần nhập mật khẩu, nhưng không cảnh báo đổi mật khẩu.
        let remote = b.read_remote(Some(&drive), Some("correct horse")).unwrap();
        assert!(b.sync_preview(&remote, Some("correct horse"), None).unwrap().warnings.is_empty());
        let (_, uploaded) = b.sync_apply(&remote, &[], Some("correct horse")).unwrap();
        // Từ giờ cả hai máy đọc được bản sao lưu mà không cần nhập lại.
        assert!(b.read_remote(Some(&uploaded), None).is_ok());
        assert!(a.read_remote(Some(&uploaded), None).is_ok());
        b.lock();
        b.unlock(Some("correct horse")).unwrap();
        cleanup(&[&a, &b]);
    }

    #[test]
    fn restore_preview_lists_accounts_that_would_be_lost() {
        let mut a = temp_vault();
        a.create(Some("correct horse")).unwrap();
        a.add(account_with("AAAAAAAA")).unwrap();
        let drive = a.backup_bytes().unwrap();
        a.add(account_with("BBBBBBBB")).unwrap();

        let preview = a.restore_preview(&drive, String::new()).unwrap();
        assert_eq!((preview.local_count, preview.backup_count), (2, Some(1)));
        let missing = preview.missing.unwrap();
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].issuer, "Issuer BBBBBBBB");

        // Bản sao lưu khác mật khẩu: không so sánh được nhưng vẫn cảnh báo.
        let mut b = temp_vault();
        b.create(Some("battery staple")).unwrap();
        let preview = b.restore_preview(&drive, String::new()).unwrap();
        assert!(preview.missing.is_none() && !preview.warnings.is_empty());
        cleanup(&[&a, &b]);
    }

    #[test]
    fn trash_restore_and_purge() {
        let mut vault = temp_vault();
        vault.create(Some("correct horse")).unwrap();
        let id = vault.add(sample()).unwrap().id;
        vault.remove(&id).unwrap();
        assert!(vault.codes().unwrap().is_empty());
        assert_eq!(vault.trash().unwrap().len(), 1);

        // Thùng rác được lưu cùng vault.
        vault.lock();
        vault.unlock(Some("correct horse")).unwrap();
        vault.restore_deleted(&id).unwrap();
        assert_eq!(vault.codes().unwrap().len(), 1);
        assert!(vault.trash().unwrap().is_empty());

        vault.remove(&id).unwrap();
        vault.purge_deleted(&id).unwrap();
        assert!(vault.trash().unwrap().is_empty());
        assert_eq!(vault.restore_deleted(&id).unwrap_err().code, "NOT_FOUND");
        cleanup(&[&vault]);
    }

    #[test]
    fn opens_v1_vault_and_upgrades_on_save() {
        let mut vault = temp_vault();
        vault.create(Some("correct horse")).unwrap();
        // Ghi file kiểu v1: nội dung giải mã là mảng tài khoản, không có updatedAt.
        let legacy = serde_json::json!([{
            "id": "x", "issuer": "Old", "label": "", "secret": "JBSWY3DPEHPK3PXP",
            "algorithm": "SHA1", "digits": 6, "period": 30, "createdAt": 5
        }]);
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let key = vault.unlocked().unwrap().key.clone();
        let cipher = Aes256Gcm::new_from_slice(key.as_slice()).unwrap();
        let plaintext = serde_json::to_vec(&legacy).unwrap();
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: &plaintext, aad: AAD })
            .unwrap();
        let mut file = vault.read_file().unwrap();
        file.version = 1;
        file.nonce = BASE64.encode(&nonce);
        file.ciphertext = BASE64.encode(&ciphertext);
        fs::write(&vault.path, serde_json::to_vec(&file).unwrap()).unwrap();

        let mut reopened = Vault::new(vault.path.clone());
        reopened.unlock(Some("correct horse")).unwrap();
        assert_eq!(reopened.codes().unwrap()[0].issuer, "Old");
        reopened.add(account_with("CCCCCCCC")).unwrap();
        assert_eq!(reopened.read_file().unwrap().version, FILE_VERSION);
        cleanup(&[&vault]);
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

        // Máy mới đã có vault khác: khôi phục thì vault cũ được giữ trong history.
        let mut target = temp_vault();
        target.create(Some("other password")).unwrap();
        target.restore_backup(&backup).unwrap();
        assert!(!target.status().unlocked);
        assert_eq!(history_len(&target), 1);
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
        assert_eq!(history_len(&target), 1);

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
