//! Đăng nhập Google (OAuth 2.0 cho app desktop: loopback redirect + PKCE) và sao lưu
//! vault vào thư mục "Authenticator Backup" trong My Drive (scope `drive.file`: app chỉ
//! thấy file/thư mục do chính nó tạo, không đọc được file khác của người dùng).
//!
//! Client ID đọc từ `%APPDATA%\com.authenticator.app\google-oauth.json` (file JSON tải từ
//! Google Cloud Console). Refresh token được khoá bằng DPAPI trước khi ghi xuống ổ cứng.

use crate::dpapi;
use crate::error::{AppError, AppResult};
use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::OsRng;
use data_encoding::{BASE64, BASE64URL_NOPAD};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL: &str = "https://openidconnect.googleapis.com/v1/userinfo";
const DRIVE_FILES_URL: &str = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_URL: &str = "https://www.googleapis.com/upload/drive/v3/files";
const DRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
const SCOPES: &str = "openid email profile https://www.googleapis.com/auth/drive.file";
const BACKUP_NAME: &str = "vault-backup.json";
const BACKUP_FOLDER_NAME: &str = "Authenticator Backup";
const FOLDER_MIME: &str = "application/vnd.google-apps.folder";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

pub const CONFIG_FILE: &str = "google-oauth.json";
const ACCOUNT_FILE: &str = "google-account.json";

#[derive(Debug, Clone, Deserialize)]
struct ClientConfig {
    client_id: String,
    #[serde(default)]
    client_secret: String,
}

/// File tải từ Google Cloud Console có dạng `{"installed": {...}}`; chấp nhận cả dạng phẳng.
#[derive(Deserialize)]
#[serde(untagged)]
enum ConfigFile {
    Installed { installed: ClientConfig },
    Flat(ClientConfig),
}

impl ConfigFile {
    fn into_config(self) -> ClientConfig {
        match self {
            Self::Installed { installed } => installed,
            Self::Flat(config) => config,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleProfile {
    pub email: String,
    pub name: String,
    pub picture: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAccount {
    profile: GoogleProfile,
    /// Refresh token đã khoá bằng DPAPI (base64).
    refresh_token: String,
    /// Các scope người dùng đã cấp (cách nhau bởi dấu cách).
    #[serde(default)]
    scope: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    /// RFC 3339, ví dụ "2026-09-24T09:30:00.000Z".
    pub modified_time: Option<String>,
    pub size: Option<u64>,
}

impl BackupInfo {
    fn from_file(file: Option<DriveFile>) -> Option<Self> {
        file.map(|f| Self {
            modified_time: f.modified_time,
            size: f.size.and_then(|s| s.parse().ok()),
        })
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    refresh_token: Option<String>,
    #[serde(default)]
    scope: String,
}

#[derive(Deserialize)]
struct UserInfo {
    email: String,
    name: Option<String>,
    picture: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveFile {
    id: String,
    modified_time: Option<String>,
    /// Drive trả int64 dưới dạng chuỗi.
    size: Option<String>,
    /// Link mở file/thư mục trên drive.google.com.
    web_view_link: Option<String>,
}

#[derive(Deserialize)]
struct DriveFileList {
    files: Vec<DriveFile>,
}

struct Inner {
    account: Option<StoredAccount>,
    /// Access token còn hạn trong RAM (không ghi xuống ổ cứng).
    access: Option<(String, Instant)>,
}

pub struct Google {
    dir: PathBuf,
    http: reqwest::Client,
    inner: Mutex<Inner>,
}

impl Google {
    pub fn new(dir: PathBuf) -> Self {
        // Tài khoản đăng nhập từ bản cũ (scope drive.appdata) không có quyền drive.file:
        // coi như chưa đăng nhập để người dùng đăng nhập lại và cấp quyền mới.
        let account = fs::read(dir.join(ACCOUNT_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<StoredAccount>(&bytes).ok())
            .filter(|account| has_drive_scope(&account.scope));
        Self {
            dir,
            http: reqwest::Client::new(),
            inner: Mutex::new(Inner {
                account,
                access: None,
            }),
        }
    }

    /// Ưu tiên file trong thư mục dữ liệu của app, không có thì dùng cấu hình nhúng lúc build.
    fn config(&self) -> AppResult<ClientConfig> {
        let path = self.dir.join(CONFIG_FILE);
        let (bytes, source) = match fs::read(&path) {
            Ok(bytes) => (bytes, format!("File {}", path.display())),
            Err(_) => match option_env!("GOOGLE_OAUTH_CONFIG") {
                Some(embedded) => (embedded.as_bytes().to_vec(), "Cấu hình Google nhúng lúc build".into()),
                None => {
                    return Err(AppError::new(
                        "GOOGLE_NOT_CONFIGURED",
                        format!(
                            "Chưa cấu hình đăng nhập Google. Hãy tạo OAuth Client ID (loại Desktop app) và lưu file JSON vào {} (xem README, mục \"Đăng nhập Google\").",
                            path.display()
                        ),
                    ))
                }
            },
        };
        let config = serde_json::from_slice::<ConfigFile>(&bytes)
            .map_err(|_| AppError::new("GOOGLE_NOT_CONFIGURED", format!("{source} không đúng định dạng.")))?
            .into_config();
        if config.client_id.trim().is_empty() {
            return Err(AppError::new("GOOGLE_NOT_CONFIGURED", "File cấu hình Google thiếu client_id."));
        }
        Ok(config)
    }

    pub async fn profile(&self) -> Option<GoogleProfile> {
        self.inner.lock().await.account.as_ref().map(|a| a.profile.clone())
    }

    /// Mở trình duyệt để đăng nhập, chờ Google chuyển hướng về cổng loopback.
    pub async fn sign_in(
        &self,
        open_browser: impl FnOnce(&str) -> AppResult<()>,
    ) -> AppResult<GoogleProfile> {
        let config = self.config()?;
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let redirect_uri = format!("http://127.0.0.1:{}", listener.local_addr()?.port());
        let verifier = random_token(32);
        let state = random_token(16);

        let auth_url = reqwest::Url::parse_with_params(
            AUTH_URL,
            &[
                ("client_id", config.client_id.as_str()),
                ("redirect_uri", redirect_uri.as_str()),
                ("response_type", "code"),
                ("scope", SCOPES),
                ("code_challenge", pkce_challenge(&verifier).as_str()),
                ("code_challenge_method", "S256"),
                ("state", state.as_str()),
                ("access_type", "offline"),
                ("prompt", "consent"),
            ],
        )
        .map_err(AppError::internal)?;
        open_browser(auth_url.as_str())?;

        let code = tokio::time::timeout(SIGN_IN_TIMEOUT, wait_for_code(&listener, &state))
            .await
            .map_err(|_| AppError::new("GOOGLE_TIMEOUT", "Hết thời gian chờ đăng nhập Google."))??;

        let response = self
            .http
            .post(TOKEN_URL)
            .form(&[
                ("code", code.as_str()),
                ("client_id", config.client_id.as_str()),
                ("client_secret", config.client_secret.as_str()),
                ("redirect_uri", redirect_uri.as_str()),
                ("grant_type", "authorization_code"),
                ("code_verifier", verifier.as_str()),
            ])
            .send()
            .await?;
        let tokens: TokenResponse = read_json(response).await?;
        // Google cho bỏ tick từng quyền ở màn hình đồng ý; thiếu quyền Drive thì không sao lưu được.
        if !has_drive_scope(&tokens.scope) {
            return Err(AppError::new(
                "GOOGLE_SCOPE_DENIED",
                "Cần cho phép quyền Google Drive khi đăng nhập để sao lưu. Hãy đăng nhập lại và tick ô quyền Drive.",
            ));
        }
        let refresh_token = tokens.refresh_token.ok_or_else(|| {
            AppError::new("GOOGLE_AUTH", "Google không trả refresh token, hãy thử đăng nhập lại.")
        })?;

        let user: UserInfo =
            read_json(self.http.get(USERINFO_URL).bearer_auth(&tokens.access_token).send().await?)
                .await?;
        let profile = GoogleProfile {
            name: user.name.unwrap_or_else(|| user.email.clone()),
            email: user.email,
            picture: user.picture,
        };

        let wrapped = dpapi::protect(refresh_token.as_bytes()).map_err(AppError::internal)?;
        let account = StoredAccount {
            profile: profile.clone(),
            refresh_token: BASE64.encode(&wrapped),
            scope: tokens.scope,
        };
        fs::write(self.dir.join(ACCOUNT_FILE), serde_json::to_vec_pretty(&account)?)?;

        let mut inner = self.inner.lock().await;
        inner.account = Some(account);
        inner.access = Some((tokens.access_token, expiry(tokens.expires_in)));
        Ok(profile)
    }

    pub async fn sign_out(&self) -> AppResult<()> {
        let account = {
            let mut inner = self.inner.lock().await;
            inner.access = None;
            inner.account.take()
        };
        let _ = fs::remove_file(self.dir.join(ACCOUNT_FILE));
        // Thu hồi token trên Google; lỗi mạng cũng không sao vì token trên máy đã bị xoá.
        if let Some(refresh) = account.and_then(|a| unwrap_refresh_token(&a).ok()) {
            let _ = self.http.post(REVOKE_URL).form(&[("token", refresh)]).send().await;
        }
        Ok(())
    }

    async fn access_token(&self) -> AppResult<String> {
        let mut inner = self.inner.lock().await;
        if let Some((token, expires)) = &inner.access {
            if Instant::now() < *expires {
                return Ok(token.clone());
            }
        }
        let account = inner
            .account
            .as_ref()
            .ok_or_else(|| AppError::new("GOOGLE_SIGNED_OUT", "Chưa đăng nhập Google."))?;
        let refresh = unwrap_refresh_token(account)?;
        let config = self.config()?;

        let response = self
            .http
            .post(TOKEN_URL)
            .form(&[
                ("client_id", config.client_id.as_str()),
                ("client_secret", config.client_secret.as_str()),
                ("refresh_token", refresh.as_str()),
                ("grant_type", "refresh_token"),
            ])
            .send()
            .await?;
        match read_json::<TokenResponse>(response).await {
            Ok(tokens) => {
                inner.access = Some((tokens.access_token.clone(), expiry(tokens.expires_in)));
                Ok(tokens.access_token)
            }
            Err(e) => {
                if e.code == "GOOGLE_SESSION_EXPIRED" {
                    inner.account = None;
                    let _ = fs::remove_file(self.dir.join(ACCOUNT_FILE));
                }
                Err(e)
            }
        }
    }

    /// Tìm file/thư mục do app tạo (với drive.file, Drive chỉ trả về những file như vậy).
    async fn find(&self, token: &str, query: &str) -> AppResult<Option<DriveFile>> {
        let response = self
            .http
            .get(DRIVE_FILES_URL)
            .bearer_auth(token)
            .query(&[
                ("q", query),
                ("fields", "files(id,modifiedTime,size,webViewLink)"),
                ("orderBy", "modifiedTime desc"),
            ])
            .send()
            .await?;
        let list: DriveFileList = read_json(response).await?;
        Ok(list.files.into_iter().next())
    }

    async fn find_folder(&self, token: &str) -> AppResult<Option<DriveFile>> {
        let query = format!(
            "name = '{BACKUP_FOLDER_NAME}' and mimeType = '{FOLDER_MIME}' and trashed = false"
        );
        self.find(token, &query).await
    }

    /// Bản sao lưu ở bất kỳ đâu trong Drive (người dùng có thể đã chuyển nó sang thư mục khác).
    async fn find_backup(&self, token: &str) -> AppResult<Option<DriveFile>> {
        let query = format!("name = '{BACKUP_NAME}' and mimeType != '{FOLDER_MIME}' and trashed = false");
        self.find(token, &query).await
    }

    async fn ensure_folder(&self, token: &str) -> AppResult<DriveFile> {
        if let Some(folder) = self.find_folder(token).await? {
            return Ok(folder);
        }
        let response = self
            .http
            .post(DRIVE_FILES_URL)
            .bearer_auth(token)
            .query(&[("fields", "id,webViewLink")])
            .json(&json!({ "name": BACKUP_FOLDER_NAME, "mimeType": FOLDER_MIME }))
            .send()
            .await?;
        read_json(response).await
    }

    pub async fn backup_info(&self) -> AppResult<Option<BackupInfo>> {
        let token = self.access_token().await?;
        Ok(BackupInfo::from_file(self.find_backup(&token).await?))
    }

    /// Link thư mục "Authenticator Backup" trên drive.google.com (tạo thư mục nếu chưa có).
    pub async fn backup_folder_url(&self) -> AppResult<String> {
        let token = self.access_token().await?;
        let folder = self.ensure_folder(&token).await?;
        Ok(folder
            .web_view_link
            .unwrap_or_else(|| format!("https://drive.google.com/drive/folders/{}", folder.id)))
    }

    /// Ghi đè bản sao lưu duy nhất (tạo mới trong thư mục "Authenticator Backup" nếu chưa có).
    pub async fn backup(&self, vault_file: Vec<u8>) -> AppResult<BackupInfo> {
        let token = self.access_token().await?;
        let id = match self.find_backup(&token).await? {
            Some(file) => file.id,
            None => {
                let folder = self.ensure_folder(&token).await?;
                let response = self
                    .http
                    .post(DRIVE_FILES_URL)
                    .bearer_auth(&token)
                    .query(&[("fields", "id")])
                    .json(&json!({
                        "name": BACKUP_NAME,
                        "parents": [folder.id],
                        "mimeType": "application/json",
                    }))
                    .send()
                    .await?;
                read_json::<DriveFile>(response).await?.id
            }
        };
        let response = self
            .http
            .patch(format!("{DRIVE_UPLOAD_URL}/{id}"))
            .bearer_auth(&token)
            .query(&[("uploadType", "media"), ("fields", "id,modifiedTime,size,webViewLink")])
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(vault_file)
            .send()
            .await?;
        let file: DriveFile = read_json(response).await?;
        Ok(BackupInfo::from_file(Some(file)).expect("có file"))
    }

    pub async fn download_backup(&self) -> AppResult<Vec<u8>> {
        let token = self.access_token().await?;
        let file = self.find_backup(&token).await?.ok_or_else(|| {
            AppError::new("NO_BACKUP", "Tài khoản Google này chưa có bản sao lưu nào.")
        })?;
        let response = self
            .http
            .get(format!("{DRIVE_FILES_URL}/{}", file.id))
            .bearer_auth(&token)
            .query(&[("alt", "media")])
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            return Err(google_error(status, &response.text().await.unwrap_or_default()));
        }
        Ok(response.bytes().await?.to_vec())
    }
}

fn has_drive_scope(scope: &str) -> bool {
    scope.split_whitespace().any(|s| s == DRIVE_SCOPE)
}

fn unwrap_refresh_token(account: &StoredAccount) -> AppResult<String> {
    let blob = BASE64
        .decode(account.refresh_token.as_bytes())
        .map_err(AppError::internal)?;
    let raw = dpapi::unprotect(&blob).map_err(|_| {
        AppError::new("GOOGLE_SESSION_EXPIRED", "Phiên đăng nhập Google không hợp lệ, hãy đăng nhập lại.")
    })?;
    String::from_utf8(raw.to_vec()).map_err(AppError::internal)
}

/// Hết hạn sớm 60 giây để không dùng token sát giờ hết hạn.
fn expiry(expires_in: u64) -> Instant {
    Instant::now() + Duration::from_secs(expires_in.saturating_sub(60))
}

fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    OsRng.fill_bytes(&mut buf);
    BASE64URL_NOPAD.encode(&buf)
}

/// PKCE S256: base64url(sha256(verifier)).
fn pkce_challenge(verifier: &str) -> String {
    BASE64URL_NOPAD.encode(&Sha256::digest(verifier.as_bytes()))
}

async fn read_json<T: DeserializeOwned>(response: reqwest::Response) -> AppResult<T> {
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        return Err(google_error(status, &body));
    }
    serde_json::from_str(&body).map_err(AppError::internal)
}

fn google_error(status: reqwest::StatusCode, body: &str) -> AppError {
    let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    if status == reqwest::StatusCode::FORBIDDEN && body.contains("insufficient") {
        return AppError::new(
            "GOOGLE_SCOPE_DENIED",
            "Thiếu quyền Google Drive. Hãy đăng xuất rồi đăng nhập Google lại.",
        );
    }
    if value["error"] == "invalid_grant" {
        return AppError::new(
            "GOOGLE_SESSION_EXPIRED",
            "Phiên đăng nhập Google đã hết hạn, hãy đăng nhập lại.",
        );
    }
    let message = value["error_description"]
        .as_str()
        .or_else(|| value["error"]["message"].as_str())
        .or_else(|| value["error"].as_str())
        .unwrap_or(body);
    AppError::new("GOOGLE_API", format!("Google báo lỗi ({status}): {message}"))
}

const SUCCESS_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Authenticator</title>\
<body style=\"font-family:Segoe UI,sans-serif;text-align:center;padding-top:80px\">\
<h2>✅ Đăng nhập Google thành công</h2><p>Bạn có thể đóng tab này và quay lại app Authenticator.</p>";
const FAILURE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Authenticator</title>\
<body style=\"font-family:Segoe UI,sans-serif;text-align:center;padding-top:80px\">\
<h2>❌ Đăng nhập Google không thành công</h2><p>Hãy quay lại app Authenticator và thử lại.</p>";

/// Chờ trình duyệt gọi `http://127.0.0.1:<port>/?code=...&state=...`.
async fn wait_for_code(listener: &TcpListener, expected_state: &str) -> AppResult<String> {
    loop {
        let (mut stream, _) = listener.accept().await?;
        let mut buf = vec![0u8; 16 * 1024];
        let n = stream.read(&mut buf).await?;
        let request = String::from_utf8_lossy(&buf[..n]);
        let target = request.split_whitespace().nth(1).unwrap_or("/");
        let params: HashMap<String, String> = reqwest::Url::parse(&format!("http://127.0.0.1{target}"))
            .map(|url| url.query_pairs().into_owned().collect())
            .unwrap_or_default();

        // Bỏ qua request khác (ví dụ /favicon.ico).
        if !params.contains_key("code") && !params.contains_key("error") {
            respond(&mut stream, "404 Not Found", "").await;
            continue;
        }

        let result = if let Some(error) = params.get("error") {
            Err(if error == "access_denied" {
                AppError::new("GOOGLE_CANCELLED", "Bạn đã huỷ đăng nhập Google.")
            } else {
                AppError::new("GOOGLE_AUTH", format!("Google báo lỗi: {error}"))
            })
        } else if params.get("state").map(String::as_str) != Some(expected_state) {
            Err(AppError::new("GOOGLE_AUTH", "Phản hồi đăng nhập không hợp lệ, hãy thử lại."))
        } else {
            Ok(params["code"].clone())
        };
        let page = if result.is_ok() { SUCCESS_PAGE } else { FAILURE_PAGE };
        respond(&mut stream, "200 OK", page).await;
        return result;
    }
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    /// Giả làm trình duyệt gọi về cổng loopback, trả về (kết quả, trang HTML nhận được).
    fn simulate_redirect(path: &'static str, state: &'static str) -> (AppResult<String>, String) {
        runtime().block_on(async {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let browser = tokio::spawn(async move {
                // Trình duyệt thường xin favicon trước; phải được bỏ qua.
                for target in ["/favicon.ico", path] {
                    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
                    let request = format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
                    stream.write_all(request.as_bytes()).await.unwrap();
                    let mut page = String::new();
                    stream.read_to_string(&mut page).await.unwrap();
                    if target == path {
                        return page;
                    }
                }
                unreachable!()
            });
            let result = wait_for_code(&listener, state).await;
            (result, browser.await.unwrap())
        })
    }

    #[test]
    fn loopback_returns_code() {
        let (result, page) = simulate_redirect("/?state=abc&code=4%2F0AbC&scope=email", "abc");
        assert_eq!(result.unwrap(), "4/0AbC");
        assert!(page.contains("thành công"));
    }

    #[test]
    fn loopback_rejects_wrong_state_and_cancel() {
        let (result, page) = simulate_redirect("/?state=evil&code=xyz", "abc");
        assert_eq!(result.unwrap_err().code, "GOOGLE_AUTH");
        assert!(page.contains("không thành công"));

        let (result, _) = simulate_redirect("/?error=access_denied&state=abc", "abc");
        assert_eq!(result.unwrap_err().code, "GOOGLE_CANCELLED");
    }

    #[test]
    fn pkce_matches_rfc7636_example() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn reads_downloaded_and_flat_config() {
        let downloaded = r#"{"installed":{"client_id":"id.apps.googleusercontent.com","project_id":"p","client_secret":"s","redirect_uris":["http://localhost"]}}"#;
        let config = serde_json::from_str::<ConfigFile>(downloaded).unwrap().into_config();
        assert_eq!(config.client_id, "id.apps.googleusercontent.com");
        assert_eq!(config.client_secret, "s");

        let flat = serde_json::from_str::<ConfigFile>(r#"{"client_id":"x"}"#).unwrap().into_config();
        assert_eq!(flat.client_id, "x");
        assert_eq!(flat.client_secret, "");
    }

    #[test]
    fn checks_drive_scope() {
        assert!(has_drive_scope(
            "openid https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email"
        ));
        assert!(!has_drive_scope("openid https://www.googleapis.com/auth/drive.appdata"));
        assert!(!has_drive_scope(""));
    }

    #[test]
    fn maps_google_errors() {
        let expired = google_error(reqwest::StatusCode::BAD_REQUEST, r#"{"error":"invalid_grant"}"#);
        assert_eq!(expired.code, "GOOGLE_SESSION_EXPIRED");
        let drive = google_error(
            reqwest::StatusCode::FORBIDDEN,
            r#"{"error":{"code":403,"message":"Drive API has not been used"}}"#,
        );
        assert_eq!(drive.code, "GOOGLE_API");
        assert!(drive.message.contains("Drive API has not been used"));
        let scope = google_error(
            reqwest::StatusCode::FORBIDDEN,
            r#"{"error":{"code":403,"message":"Request had insufficient authentication scopes."}}"#,
        );
        assert_eq!(scope.code, "GOOGLE_SCOPE_DENIED");
    }
}
