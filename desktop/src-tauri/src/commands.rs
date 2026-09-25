//! Tauri commands gọi từ frontend React qua `invoke()`.

use crate::error::{AppError, AppResult};
use crate::google::{BackupInfo, Google, GoogleProfile};
use crate::register::ExtensionInfo;
use crate::vault::{
    AccountSummary, CodeEntry, ImportPreview, ImportResult, NewAccount, SharedVault, Vault,
    VaultStatus,
};
use tauri::{AppHandle, State};
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

#[tauri::command]
pub async fn google_backup(
    vault: State<'_, SharedVault>,
    google: State<'_, Google>,
) -> AppResult<BackupInfo> {
    let bytes = with_vault(&vault, |v| v.backup_bytes())?;
    google.backup(bytes).await
}

/// Thay vault trên máy bằng bản sao lưu trên Drive. Bản mã hoá thì vault bị khoá (cần
/// master password của bản sao lưu); bản JSON không mã hoá thì vault mở sẵn.
#[tauri::command]
pub async fn google_restore(
    vault: State<'_, SharedVault>,
    google: State<'_, Google>,
) -> AppResult<()> {
    let bytes = google.download_backup().await?;
    with_vault(&vault, |v| v.restore_backup(&bytes))
}

#[tauri::command]
pub fn extension_info(info: State<'_, ExtensionInfo>) -> ExtensionInfo {
    info.inner().clone()
}
