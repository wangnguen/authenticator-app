//! Tự cập nhật âm thầm qua GitHub Releases: đọc `latest.json` của bản phát hành mới nhất, tải bản
//! cài đã ký (khoá công khai trong tauri.conf.json, bản không đúng chữ ký bị từ chối), cài rồi khởi
//! động lại. Không hỏi người dùng.
//!
//! - Mở app: có bản mới là cập nhật ngay (giao diện hiện "Đang cập nhật...").
//! - Đang chạy: kiểm tra mỗi 6 giờ; chỉ cài khi cửa sổ đang ẩn ở tray để không cắt ngang lúc đang
//!   dùng, cài xong mở lại vẫn ẩn ở tray (file đánh dấu `start-hidden`).
//!
//! Windows: bộ cài NSIS chạy im lặng (`installMode: quiet`) rồi tự mở lại app. macOS / Linux
//! (AppImage): thay bản cài rồi `restart()`.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

/// Giao diện hiện trạng thái cập nhật.
pub const UPDATE_EVENT: &str = "app-update";
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// Có bản mới nhưng người dùng đang mở cửa sổ: thử lại sau khoảng này.
const RETRY_INTERVAL: Duration = Duration::from_secs(30 * 60);
/// Có file này lúc khởi động: vừa tự cập nhật ở nền, giữ cửa sổ ẩn ở tray.
const START_HIDDEN_FILE: &str = "start-hidden";

/// Trạng thái gần nhất, để giao diện mở sau khi sự kiện đã phát vẫn biết (lệnh `update_status`).
static STATUS: Mutex<Option<UpdateStatus>> = Mutex::new(None);

#[derive(Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UpdateStatus {
    /// Đang tải / cài bản `version`; app sẽ tự khởi động lại.
    Installing { version: String },
    /// Không cài được (giữ bản hiện tại, lần sau thử lại).
    Failed { version: String, message: String },
}

fn report(app: &AppHandle, status: UpdateStatus) {
    if let Ok(mut current) = STATUS.lock() {
        *current = Some(status.clone());
    }
    let _ = app.emit(UPDATE_EVENT, status);
}

/// Trạng thái cập nhật khi mở app (`None`: không có gì đang diễn ra).
#[tauri::command]
pub fn update_status() -> Option<UpdateStatus> {
    STATUS.lock().ok().and_then(|s| s.clone())
}

/// Lần khởi động này là sau khi tự cập nhật ở nền (đọc một lần rồi xoá file đánh dấu).
pub fn take_start_hidden(data_dir: &Path) -> bool {
    fs::remove_file(data_dir.join(START_HIDDEN_FILE)).is_ok()
}

/// Bắt đầu kiểm tra cập nhật (bỏ qua khi chạy dev).
pub fn start(app: AppHandle, data_dir: PathBuf) {
    if cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut startup = true;
        loop {
            let wait = match update(&app, &data_dir, startup).await {
                Outcome::Deferred => RETRY_INTERVAL,
                Outcome::UpToDate | Outcome::Failed => CHECK_INTERVAL,
            };
            startup = false;
            tokio::time::sleep(wait).await;
        }
    });
}

enum Outcome {
    UpToDate,
    /// Có bản mới nhưng cửa sổ đang mở.
    Deferred,
    Failed,
}

fn window_visible(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

async fn update(app: &AppHandle, data_dir: &Path, startup: bool) -> Outcome {
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(e) => {
            eprintln!("Updater chưa sẵn sàng: {e}");
            return Outcome::Failed;
        }
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return Outcome::UpToDate,
        Err(e) => {
            // Mất mạng, GitHub lỗi...: lần sau thử lại, không làm phiền người dùng.
            eprintln!("Không kiểm tra được bản cập nhật: {e}");
            return Outcome::Failed;
        }
    };
    if !startup && window_visible(app) {
        return Outcome::Deferred;
    }

    let version = update.version.clone();
    if startup {
        report(app, UpdateStatus::Installing { version: version.clone() });
    }
    let fail = |message: String| {
        eprintln!("Không cập nhật được lên {version}: {message}");
        if startup {
            report(
                app,
                UpdateStatus::Failed {
                    version: version.clone(),
                    message: message.clone(),
                },
            );
        }
        Outcome::Failed
    };

    let bytes = match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => bytes,
        Err(e) => return fail(e.to_string()),
    };
    // Người dùng mở cửa sổ trong lúc đang tải: để lần sau.
    let hidden = !window_visible(app);
    if !startup && !hidden {
        return Outcome::Deferred;
    }
    let marker = data_dir.join(START_HIDDEN_FILE);
    if hidden {
        let _ = fs::write(&marker, b"");
    }
    // Windows: install() chạy bộ cài rồi thoát app ngay, bộ cài tự mở lại app.
    if let Err(e) = update.install(bytes) {
        let _ = fs::remove_file(&marker);
        return fail(e.to_string());
    }
    app.restart();
}
