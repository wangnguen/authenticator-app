use crate::google::Google;
use crate::vault::{SharedVault, Vault};
use crate::{commands, ipc, register};
use std::sync::{Arc, Mutex};
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        // Mở trình duyệt mặc định cho bước đăng nhập Google.
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            let mut vault = Vault::new(data_dir.join("vault.json"));
            // Vault không mật khẩu thì mở luôn để extension dùng được ngay.
            if let Err(e) = vault.auto_unlock() {
                eprintln!("Không tự mở khoá được vault: {e}");
            }
            let vault: SharedVault = Arc::new(Mutex::new(vault));
            app.manage(vault.clone());
            app.manage(register::register(&data_dir));
            app.manage(Google::new(data_dir.clone()));

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = ipc::serve(vault, handle).await {
                    eprintln!("IPC server dừng: {e}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault_status,
            commands::create_vault,
            commands::unlock_vault,
            commands::lock_vault,
            commands::set_password,
            commands::list_codes,
            commands::add_account,
            commands::preview_uri,
            commands::import_uri,
            commands::delete_account,
            commands::google_account,
            commands::google_sign_in,
            commands::google_sign_out,
            commands::google_backup_info,
            commands::google_open_backup_folder,
            commands::google_backup,
            commands::google_restore,
            commands::extension_info,
        ])
        .run(tauri::generate_context!())
        .expect("không khởi động được ứng dụng");
}
