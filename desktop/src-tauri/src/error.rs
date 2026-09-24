use serde::Serialize;
use std::fmt;

/// Lỗi trả về cho frontend và extension dưới dạng `{ code, message }`.
#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub code: &'static str,
    pub message: String,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn vault_exists() -> Self {
        Self::new("VAULT_EXISTS", "Vault đã tồn tại.")
    }

    pub fn no_vault() -> Self {
        Self::new("NO_VAULT", "Chưa tạo vault.")
    }

    pub fn locked() -> Self {
        Self::new("LOCKED", "Vault đang khoá. Hãy mở khoá trong app desktop.")
    }

    pub fn wrong_password() -> Self {
        Self::new("WRONG_PASSWORD", "Sai mật khẩu.")
    }

    pub fn invalid_uri(message: impl Into<String>) -> Self {
        Self::new("INVALID_URI", message)
    }

    pub fn invalid_account(message: impl Into<String>) -> Self {
        Self::new("INVALID_ACCOUNT", message)
    }

    pub fn not_found() -> Self {
        Self::new("NOT_FOUND", "Không tìm thấy tài khoản.")
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new("BAD_REQUEST", message)
    }

    pub fn internal(message: impl fmt::Display) -> Self {
        Self::new("INTERNAL", message.to_string())
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::internal(e)
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        Self::internal(e)
    }
}
