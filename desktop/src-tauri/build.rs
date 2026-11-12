use std::path::{Path, PathBuf};

fn main() {
    embed_google_oauth_config();
    embed_extension();
    tauri_build::build()
}

/// Nếu có `google-oauth.json` cạnh Cargo.toml (file bị .gitignore, không lên git) thì nhúng
/// vào exe qua biến môi trường lúc compile. Không có file thì app đọc cấu hình từ
/// `%APPDATA%\com.authenticator.app\google-oauth.json` lúc chạy.
fn embed_google_oauth_config() {
    println!("cargo:rerun-if-changed=google-oauth.json");
    let Ok(text) = std::fs::read_to_string("google-oauth.json") else {
        return;
    };
    let value: serde_json::Value =
        serde_json::from_str(&text).expect("google-oauth.json không phải JSON hợp lệ");
    println!("cargo:rustc-env=GOOGLE_OAUTH_CONFIG={value}");
}

/// Nhúng bản build của extension (`extension/dist`, tạo bằng `pnpm build:extension`) vào exe để
/// nút "Cài extension" giải nén ra cho Chrome/Edge "Load unpacked".
/// Chưa build extension thì nhúng danh sách rỗng (app báo bản build không kèm extension).
fn embed_extension() {
    let extension = Path::new("../../extension");
    let dist = extension.join("dist");
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("extension_files.rs");

    let mut files = Vec::new();
    if dist.join("manifest.json").is_file() {
        println!("cargo:rerun-if-changed={}", dist.display());
        collect(&dist, &dist, &mut files);
        files.sort();
    } else {
        // Theo dõi thư mục cha để build lại khi dist được tạo.
        println!("cargo:rerun-if-changed={}", extension.display());
        println!(
            "cargo:warning=Chưa có extension/dist: bản build này không kèm extension (chạy `pnpm build:extension` trước)."
        );
    }

    let mut code = String::from("pub static FILES: &[(&str, &[u8])] = &[\n");
    for (relative, absolute) in &files {
        code.push_str(&format!("    ({relative:?}, include_bytes!({absolute:?})),\n"));
    }
    code.push_str("];\n");
    std::fs::write(out, code).expect("không ghi được extension_files.rs");
}

/// (đường dẫn tương đối dùng `/`, đường dẫn tuyệt đối) của mọi file trong `dir`.
fn collect(root: &Path, dir: &Path, files: &mut Vec<(String, String)>) {
    for entry in std::fs::read_dir(dir).expect("không đọc được extension/dist") {
        let path = entry.expect("không đọc được extension/dist").path();
        if path.is_dir() {
            collect(root, &path, files);
        } else {
            let relative = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            let absolute = std::path::absolute(&path).unwrap().to_string_lossy().into_owned();
            files.push((relative, absolute));
        }
    }
}
