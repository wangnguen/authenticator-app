fn main() {
    embed_google_oauth_config();
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
