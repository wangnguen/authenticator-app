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
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            let vault: SharedVault = Arc::new(Mutex::new(Vault::new(data_dir.join("vault.json"))));
            app.manage(vault.clone());
            app.manage(register::register(&data_dir));

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
            commands::list_codes,
            commands::add_account,
            commands::add_account_uri,
            commands::delete_account,
            commands::extension_info,
        ])
        .run(tauri::generate_context!())
        .expect("không khởi động được ứng dụng");
}
