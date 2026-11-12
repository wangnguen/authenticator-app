//! Tauri commands gọi từ frontend React qua `invoke()`.

use crate::browser_extension::{self, Browser, ExtensionPackage};
use crate::error::{AppError, AppResult};
use crate::google::{BackupInfo, Google, GoogleProfile};
use crate::register::ExtensionInfo;
use crate::sync::SyncSummary;
use crate::vault::{
    AccountSummary, CodeEntry, ImportPreview, ImportResult, NewAccount, RestorePreview,
    SharedVault, SyncPreview, TrashEntry, Vault, VaultStatus,
};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

fn with_vault<T>(vault: &SharedVault, f: impl FnOnce(&mut Vault) -> AppResult<T>) -> AppResult<T> {
    let mut guard = vault
        .lock()
        .map_err(|_| AppError::internal("vault mutex poisoned"))?;
    f(&mut guard)
}

/// Argon2 tốn vài trăm ms, chạy ngoài main thread để UI không bị đơ.
async fn with_vault_blocking<T: Send + 'static>(
    vault: SharedVault,
    f: impl FnOnce(&mut Vault) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(move || with_vault(&vault, f))
        .await
        .map_err(AppError::internal)?
}

#[tauri::command]
pub fn vault_status(vault: State<'_, SharedVault>) -> AppResult<VaultStatus> {
    with_vault(&vault, |v| Ok(v.status()))
}

/// `password = null`: tạo vault không mật khẩu (tự mở khoá bằng tài khoản Windows).
#[tauri::command]
pub async fn create_vault(vault: State<'_, SharedVault>, password: Option<String>) -> AppResult<()> {
    with_vault_blocking(vault.inner().clone(), move |v| v.create(password.as_deref())).await
}

#[tauri::command]
pub async fn unlock_vault(vault: State<'_, SharedVault>, password: Option<String>) -> AppResult<()> {
    with_vault_blocking(vault.inner().clone(), move |v| v.unlock(password.as_deref())).await
}

/// Đặt, đổi hoặc bỏ master password (`newPassword = null` là bỏ).
#[tauri::command]
pub async fn set_password(
    vault: State<'_, SharedVault>,
    current_password: Option<String>,
    new_password: Option<String>,
) -> AppResult<()> {
    with_vault_blocking(vault.inner().clone(), move |v| {
        v.set_password(current_password.as_deref(), new_password.as_deref())
    })
    .await
}

#[tauri::command]
pub fn lock_vault(vault: State<'_, SharedVault>) -> AppResult<()> {
    with_vault(&vault, |v| {
        v.lock();
        Ok(())
    })
}

#[tauri::command]
pub fn list_codes(vault: State<'_, SharedVault>) -> AppResult<Vec<CodeEntry>> {
    with_vault(&vault, |v| v.codes())
}

#[tauri::command]
pub fn add_account(vault: State<'_, SharedVault>, account: NewAccount) -> AppResult<AccountSummary> {
    with_vault(&vault, |v| v.add(account))
}

/// Xem trước tài khoản đọc được từ link/QR trước khi bấm "Thêm".
#[tauri::command]
pub fn preview_uri(vault: State<'_, SharedVault>, uri: String) -> AppResult<ImportPreview> {
    with_vault(&vault, |v| v.preview_uri(&uri))
}

#[tauri::command]
pub fn import_uri(vault: State<'_, SharedVault>, uri: String) -> AppResult<ImportResult> {
    with_vault(&vault, |v| v.import_uri(&uri))
}

#[tauri::command]
pub fn delete_account(vault: State<'_, SharedVault>, id: String) -> AppResult<()> {
    with_vault(&vault, |v| v.remove(&id))
}

#[tauri::command]
pub async fn google_account(google: State<'_, Google>) -> AppResult<Option<GoogleProfile>> {
    Ok(google.profile().await)
}

/// Mở trình duyệt để đăng nhập Google, trả về khi người dùng đăng nhập xong.
#[tauri::command]
pub async fn google_sign_in(app: AppHandle, google: State<'_, Google>) -> AppResult<GoogleProfile> {
    google
        .sign_in(|url| {
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(AppError::internal)
        })
        .await
}

#[tauri::command]
pub async fn google_sign_out(google: State<'_, Google>) -> AppResult<()> {
    google.sign_out().await
}

#[tauri::command]
pub async fn google_backup_info(google: State<'_, Google>) -> AppResult<Option<BackupInfo>> {
    google.backup_info().await
}

/// Mở thư mục "Authenticator Backup" trên Google Drive bằng trình duyệt.
#[tauri::command]
pub async fn google_open_backup_folder(app: AppHandle, google: State<'_, Google>) -> AppResult<()> {
    let url = google.backup_folder_url().await?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(AppError::internal)
}

/// Xem trước đồng bộ với Google Drive (không thay đổi gì).
/// `backup_password`: chỉ cần khi bản sao lưu dùng master password khác với máy này.
#[tauri::command]
pub async fn google_sync_preview(
    vault: State<'_, SharedVault>,
    google: State<'_, Google>,
    backup_password: Option<String>,
) -> AppResult<SyncPreview> {
    let remote = google.fetch_backup().await?;
    let version = remote.as_ref().map(|r| r.modified_time.clone());
    with_vault_blocking(vault.inner().clone(), move |v| {
        let password = backup_password.as_deref();
        let remote = v.read_remote(remote.as_ref().map(|r| r.bytes.as_slice()), password)?;
        v.sync_preview(&remote, password, version)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    #[serde(flatten)]
    summary: SyncSummary,
    backup: BackupInfo,
}

fn backup_changed() -> AppError {
    AppError::new(
        "BACKUP_CHANGED",
        "Bản sao lưu trên Drive vừa được máy khác cập nhật. Hãy xem lại trước khi tiếp tục.",
    )
}

/// Đồng bộ 2 chiều: gộp bản trên Drive vào máy rồi tải bản đã gộp lên.
/// Chỉ xoá các tài khoản có id trong `confirmed_deletions`, còn lại được giữ.
/// `backup_version` lấy từ bản xem trước: bản trên Drive đã đổi thì dừng lại để người dùng xem
/// lại, tránh âm thầm giữ/xoá các tài khoản chưa được hỏi.
#[tauri::command]
pub async fn google_sync(
    vault: State<'_, SharedVault>,
    google: State<'_, Google>,
    backup_password: Option<String>,
    confirmed_deletions: Vec<String>,
    backup_version: Option<String>,
) -> AppResult<SyncResult> {
    let remote = google.fetch_backup().await?;
    let expected = remote.as_ref().map(|r| r.modified_time.clone());
    if expected != backup_version {
        return Err(backup_changed());
    }
    let (summary, bytes) = with_vault_blocking(vault.inner().clone(), move |v| {
        let password = backup_password.as_deref();
        let remote = v.read_remote(remote.as_ref().map(|r| r.bytes.as_slice()), password)?;
        v.sync_apply(&remote, &confirmed_deletions, password)
    })
    .await?;
    let backup = google.upload_backup(bytes, expected).await?;
    Ok(SyncResult { summary, backup })
}

/// So sánh vault trên máy với bản sao lưu trước khi khôi phục.
#[tauri::command]
pub async fn google_restore_preview(
    vault: State<'_, SharedVault>,
    google: State<'_, Google>,
) -> AppResult<RestorePreview> {
    let backup = google.download_backup().await?;
    with_vault_blocking(vault.inner().clone(), move |v| {
        v.restore_preview(&backup.bytes, backup.modified_time)
    })
    .await
}

/// Thay vault trên máy bằng bản sao lưu trên Drive (vault cũ được giữ trong thư mục history).
/// Bản mã hoá thì vault bị khoá (cần master password của bản sao lưu); bản JSON không mã hoá
/// thì vault mở sẵn.
/// `backup_version`: lấy từ `google_restore_preview` (bỏ trống ở màn hình tạo vault, khi máy chưa
/// có gì để mất); bản trên Drive đã đổi kể từ lúc so sánh thì dừng lại.
#[tauri::command]
pub async fn google_restore(
    vault: State<'_, SharedVault>,
    google: State<'_, Google>,
    backup_version: Option<String>,
) -> AppResult<()> {
    let backup = google.download_backup().await?;
    if backup_version.is_some_and(|v| v != backup.modified_time) {
        return Err(backup_changed());
    }
    with_vault(&vault, |v| v.restore_backup(&backup.bytes))
}

#[tauri::command]
pub fn list_trash(vault: State<'_, SharedVault>) -> AppResult<Vec<TrashEntry>> {
    with_vault(&vault, |v| v.trash())
}

#[tauri::command]
pub fn restore_deleted(vault: State<'_, SharedVault>, id: String) -> AppResult<AccountSummary> {
    with_vault(&vault, |v| v.restore_deleted(&id))
}

#[tauri::command]
pub fn purge_deleted(vault: State<'_, SharedVault>, id: String) -> AppResult<()> {
    with_vault(&vault, |v| v.purge_deleted(&id))
}

#[tauri::command]
pub fn extension_info(info: State<'_, ExtensionInfo>) -> ExtensionInfo {
    info.inner().clone()
}

fn data_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path().app_data_dir().map_err(AppError::internal)
}

#[tauri::command]
pub fn extension_package(app: AppHandle) -> AppResult<ExtensionPackage> {
    Ok(browser_extension::info(&data_dir(&app)?))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallExtensionResult {
    package: ExtensionPackage,
    /// Giải nén được nhưng không mở được trình duyệt (ví dụ máy không cài Chrome).
    browser_error: Option<String>,
}

/// Giải nén extension rồi mở trang extensions của trình duyệt để người dùng "Load unpacked".
#[tauri::command]
pub fn install_extension(app: AppHandle, browser: Browser) -> AppResult<InstallExtensionResult> {
    let package = browser_extension::extract(&data_dir(&app)?)?;
    let browser_error = browser_extension::open_extensions_page(browser)
        .err()
        .map(|e| e.message);
    Ok(InstallExtensionResult {
        package,
        browser_error,
    })
}

#[tauri::command]
pub fn open_extension_folder(app: AppHandle) -> AppResult<()> {
    let path = browser_extension::info(&data_dir(&app)?)
        .path
        .ok_or_else(|| AppError::new("NOT_FOUND", "Chưa giải nén extension."))?;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(AppError::internal)
}
