use crate::google::Google;
use crate::pairing::{Pairing, SharedPairing};
use crate::vault::{SharedVault, Vault};
use crate::{browser_extension, commands, ipc, register};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, WindowEvent};

/// Đã có icon ở khay hệ thống: đóng cửa sổ thì ẩn xuống tray thay vì thoát.
static TRAY_READY: AtomicBool = AtomicBool::new(false);

/// Vault vừa bị khoá từ menu tray: giao diện chuyển sang màn hình mở khoá.
#[cfg_attr(not(windows), allow(dead_code))]
pub const VAULT_LOCKED_EVENT: &str = "vault-locked";

/// Cửa sổ chính vừa ẩn xuống tray: giao diện tắt webcam (nếu đang quét QR).
pub const WINDOW_HIDDEN_EVENT: &str = "window-hidden";

/// Hiện cửa sổ chính (kể cả khi đang ẩn ở tray) và đưa lên trước.
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Icon ở khay hệ thống: đóng cửa sổ thì app vẫn chạy nền để extension luôn lấy được mã.
/// Chỉ trên Windows: kết nối extension (named pipe) chỉ có ở Windows, và trên Linux thiếu thư viện
/// appindicator thì tạo tray có thể làm app crash.
#[cfg(windows)]
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "Mở Authenticator", true, None::<&str>)?;
    let lock = MenuItem::with_id(app, "lock", "Khoá vault", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Thoát", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &lock, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Authenticator (đang chạy nền)")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "lock" => {
                // Không chờ khoá vault trên luồng giao diện (đồng bộ có thể đang giữ vài trăm ms).
                let app = app.clone();
                std::thread::spawn(move || {
                    use tauri::Emitter;
                    let Some(vault) = app.try_state::<SharedVault>() else {
                        return;
                    };
                    let locked = vault.lock().map(|mut v| v.lock()).is_ok();
                    if locked {
                        let _ = app.emit(VAULT_LOCKED_EVENT, ());
                    }
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    TRAY_READY.store(true, Ordering::Relaxed);
    Ok(())
}

#[cfg(not(windows))]
fn setup_tray(_app: &tauri::App) -> tauri::Result<()> {
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        // Mở trình duyệt mặc định cho bước đăng nhập Google.
        .plugin(tauri_plugin_opener::init())
        // Đóng cửa sổ chính = ẩn xuống tray; thoát hẳn bằng menu "Thoát" của tray.
        // Không có tray (lỗi, hoặc không phải Windows) thì đóng là thoát như bình thường.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && TRAY_READY.load(Ordering::Relaxed) {
                    use tauri::Emitter;
                    api.prevent_close();
                    let _ = window.hide();
                    let _ = window.emit(WINDOW_HIDDEN_EVENT, ());
                }
            }
        })
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
            // App vừa cập nhật: cập nhật luôn thư mục extension đã giải nén trước đó (chạy nền để
            // không làm chậm lúc mở cửa sổ).
            let extension_dir = data_dir.clone();
            std::thread::spawn(move || {
                if let Err(e) = browser_extension::refresh_if_outdated(&extension_dir) {
                    eprintln!("Không cập nhật được thư mục extension: {e}");
                }
            });
            app.manage(Google::new(data_dir.clone()));
            let pairing: SharedPairing = Arc::new(Pairing::load(data_dir.clone()));
            app.manage(pairing.clone());

            if let Err(e) = setup_tray(app) {
                eprintln!("Không tạo được icon ở khay hệ thống: {e}");
            }

            let ctx = ipc::Context {
                vault,
                pairing,
                app: app.handle().clone(),
            };
            tauri::async_runtime::spawn(async move {
                if let Err(e) = ipc::serve(ctx).await {
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
            commands::google_sync_preview,
            commands::google_sync,
            commands::google_restore_preview,
            commands::google_restore,
            commands::list_trash,
            commands::restore_deleted,
            commands::purge_deleted,
            commands::extension_info,
            commands::extension_package,
            commands::install_extension,
            commands::open_extension_folder,
            commands::pairing_pending,
            commands::pairing_decide,
            commands::paired_extensions,
            commands::revoke_extension,
        ])
        .run(tauri::generate_context!())
        .expect("không khởi động được ứng dụng");
}
