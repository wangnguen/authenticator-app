//! Đăng ký native messaging host cho Chrome và Edge (HKCU, không cần quyền admin).

use serde::Serialize;
use std::io;
use std::path::{Path, PathBuf};

/// Phải khớp với NATIVE_HOST_NAME trong packages/core/src/protocol.ts.
pub const HOST_NAME: &str = "com.authenticator.app";
/// ID cố định nhờ trường "key" trong extension/public/manifest.json.
pub const EXTENSION_ID: &str = "dhlimcjaejobpdoekahaiiojdgmmgkno";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionInfo {
    pub host_name: String,
    pub extension_id: String,
    pub manifest_path: Option<String>,
    pub error: Option<String>,
}

pub fn register(data_dir: &Path) -> ExtensionInfo {
    let result = try_register(data_dir);
    if let Err(e) = &result {
        eprintln!("Không đăng ký được native messaging host: {e}");
    }
    ExtensionInfo {
        host_name: HOST_NAME.into(),
        extension_id: EXTENSION_ID.into(),
        manifest_path: result
            .as_ref()
            .ok()
            .map(|p| p.to_string_lossy().into_owned()),
        error: result.err().map(|e| e.to_string()),
    }
}

#[cfg(windows)]
fn try_register(data_dir: &Path) -> io::Result<PathBuf> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let manifest = serde_json::json!({
        "name": HOST_NAME,
        "description": "Authenticator desktop bridge",
        "path": std::env::current_exe()?,
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{EXTENSION_ID}/")],
    });
    let manifest_path = data_dir.join("native-host.json");
    std::fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?)?;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let value = manifest_path.to_string_lossy().into_owned();
    for browser in [r"Software\Google\Chrome", r"Software\Microsoft\Edge"] {
        let (key, _) = hkcu.create_subkey(format!(r"{browser}\NativeMessagingHosts\{HOST_NAME}"))?;
        key.set_value("", &value)?;
    }
    Ok(manifest_path)
}

#[cfg(not(windows))]
fn try_register(_data_dir: &Path) -> io::Result<PathBuf> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "chỉ hỗ trợ Windows"))
}
