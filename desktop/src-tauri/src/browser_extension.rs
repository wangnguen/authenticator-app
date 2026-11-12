//! Cài extension Chrome/Edge khi extension chưa có trên Store: app nhúng sẵn bản build của
//! extension (xem `build.rs`), giải nén ra `<app data>/extension` để người dùng "Load unpacked".
//! Extension ID vẫn cố định nhờ trường `key` trong manifest, nên native host nhận ra nó.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

mod bundled {
    // `pub static FILES: &[(&str, &[u8])]`: (đường dẫn tương đối, nội dung) do build.rs sinh ra.
    include!(concat!(env!("OUT_DIR"), "/extension_files.rs"));
}

use bundled::FILES;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionPackage {
    /// Bản build này có kèm extension.
    pub bundled: bool,
    /// Version trong manifest.json của extension được nhúng.
    pub version: Option<String>,
    /// Thư mục đã giải nén (chọn thư mục này khi "Load unpacked"); `None` nếu chưa giải nén.
    pub path: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Browser {
    Chrome,
    Edge,
}

fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("extension")
}

fn bundled_version() -> Option<String> {
    let (_, manifest) = FILES.iter().find(|(path, _)| *path == "manifest.json")?;
    let manifest: serde_json::Value = serde_json::from_slice(manifest).ok()?;
    manifest["version"].as_str().map(str::to_owned)
}

pub fn info(data_dir: &Path) -> ExtensionPackage {
    let dir = dir(data_dir);
    ExtensionPackage {
        bundled: !FILES.is_empty(),
        version: bundled_version(),
        path: dir
            .join("manifest.json")
            .is_file()
            .then(|| dir.to_string_lossy().into_owned()),
    }
}

/// Giải nén extension (thay bản cũ). Ghi vào thư mục tạm rồi đổi tên, để không bao giờ để lại
/// thư mục extension dở dang.
pub fn extract(data_dir: &Path) -> AppResult<ExtensionPackage> {
    if FILES.is_empty() {
        return Err(AppError::new(
            "NO_EXTENSION",
            "Bản build này không kèm extension. Chạy `pnpm build:extension` rồi build lại app.",
        ));
    }
    let target = dir(data_dir);
    let tmp = data_dir.join("extension.tmp");
    if tmp.exists() {
        fs::remove_dir_all(&tmp)?;
    }
    for (relative, bytes) in FILES {
        let path = tmp.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, bytes)?;
    }
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|e| {
            AppError::new(
                "EXTENSION_BUSY",
                format!("Không thay được thư mục extension cũ ({e}). Đóng trình duyệt rồi thử lại."),
            )
        })?;
    }
    fs::rename(&tmp, &target)?;
    Ok(info(data_dir))
}

/// Gọi lúc khởi động: extension đã giải nén mà khác bản nhúng trong app (app vừa cập nhật) thì
/// giải nén lại. Trình duyệt nạp bản mới khi khởi động lại hoặc khi bấm "Reload" extension.
pub fn refresh_if_outdated(data_dir: &Path) -> AppResult<()> {
    let dir = dir(data_dir);
    if FILES.is_empty() || !dir.join("manifest.json").is_file() {
        return Ok(());
    }
    let outdated = FILES
        .iter()
        .any(|(relative, bytes)| fs::read(dir.join(relative)).map_or(true, |disk| disk != *bytes));
    if outdated {
        extract(data_dir)?;
    }
    Ok(())
}

/// Mở trang quản lý extension (`chrome://extensions` / `edge://extensions`).
#[cfg(windows)]
pub fn open_extensions_page(browser: Browser) -> AppResult<()> {
    let (exe, url, name) = match browser {
        Browser::Chrome => ("chrome.exe", "chrome://extensions", "Google Chrome"),
        Browser::Edge => ("msedge.exe", "edge://extensions", "Microsoft Edge"),
    };
    let path = app_path(exe).ok_or_else(|| {
        AppError::new("BROWSER_NOT_FOUND", format!("Không tìm thấy {name} trên máy này."))
    })?;
    std::process::Command::new(path)
        .arg(url)
        .spawn()
        .map_err(|e| AppError::new("BROWSER_NOT_FOUND", format!("Không mở được {name}: {e}")))?;
    Ok(())
}

#[cfg(not(windows))]
pub fn open_extensions_page(_browser: Browser) -> AppResult<()> {
    Err(AppError::new(
        "BROWSER_NOT_FOUND",
        "Kết nối extension hiện chỉ hỗ trợ Windows.",
    ))
}

/// Đường dẫn exe của trình duyệt, theo khoá "App Paths" mà bộ cài Chrome/Edge đăng ký.
#[cfg(windows)]
fn app_path(exe: &str) -> Option<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let subkey = format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe}");
    [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE].into_iter().find_map(|root| {
        let value: String = RegKey::predef(root).open_subkey(&subkey).ok()?.get_value("").ok()?;
        let path = PathBuf::from(value.trim_matches('"'));
        path.is_file().then_some(path)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_and_refresh() {
        let data_dir = std::env::temp_dir().join(format!("auth-ext-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&data_dir).unwrap();
        assert!(info(&data_dir).path.is_none());

        if FILES.is_empty() {
            // Build chưa kèm extension (CI chạy test trước khi build extension).
            assert_eq!(extract(&data_dir).unwrap_err().code, "NO_EXTENSION");
        } else {
            let package = extract(&data_dir).unwrap();
            assert!(package.bundled && package.version.is_some());
            let manifest = dir(&data_dir).join("manifest.json");
            assert!(manifest.is_file());

            // Bản trên đĩa bị sửa (giống app vừa cập nhật): khởi động lại thì giải nén lại.
            fs::write(&manifest, b"{}").unwrap();
            refresh_if_outdated(&data_dir).unwrap();
            assert_ne!(fs::read(&manifest).unwrap(), b"{}");
        }
        let _ = fs::remove_dir_all(&data_dir);
    }
}
