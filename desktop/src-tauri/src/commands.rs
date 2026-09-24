//! Tauri commands gọi từ frontend React qua `invoke()`.

use crate::error::{AppError, AppResult};
use crate::otpauth;
use crate::register::ExtensionInfo;
use crate::vault::{AccountSummary, CodeEntry, NewAccount, SharedVault, Vault, VaultStatus};
use tauri::State;

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

#[tauri::command]
pub async fn create_vault(vault: State<'_, SharedVault>, password: String) -> AppResult<()> {
    with_vault_blocking(vault.inner().clone(), move |v| v.create(&password)).await
}

#[tauri::command]
pub async fn unlock_vault(vault: State<'_, SharedVault>, password: String) -> AppResult<()> {
    with_vault_blocking(vault.inner().clone(), move |v| v.unlock(&password)).await
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

#[tauri::command]
pub fn add_account_uri(vault: State<'_, SharedVault>, uri: String) -> AppResult<AccountSummary> {
    with_vault(&vault, |v| v.add(otpauth::parse(&uri)?))
}

#[tauri::command]
pub fn delete_account(vault: State<'_, SharedVault>, id: String) -> AppResult<()> {
    with_vault(&vault, |v| v.remove(&id))
}

#[tauri::command]
pub fn extension_info(info: State<'_, ExtensionInfo>) -> ExtensionInfo {
    info.inner().clone()
}
