//! Named pipe server: nhận request từ native host (extension) và trả kết quả.
//! Mỗi request/response là một dòng JSON. Trừ `ping` và các lệnh ghép đôi, mọi request phải có
//! token của extension đã được cho phép (xem `pairing.rs`).

use crate::error::{AppError, AppResult};
use crate::pairing::SharedPairing;
use crate::vault::SharedVault;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

pub const PIPE_NAME: &str = r"\\.\pipe\com.authenticator.app";
pub const VAULT_CHANGED_EVENT: &str = "vault-changed";
/// Extension xin ghép đôi: giao diện hiện hộp thoại Cho phép / Từ chối.
pub const PAIR_REQUEST_EVENT: &str = "pair-request";

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Command {
    Ping,
    PairRequest {
        /// Extension tự tạo và lưu trước khi gửi, vì popup đóng ngay khi app bật lên.
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(default)]
        name: String,
    },
    PairStatus {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    Status,
    ListCodes,
    ListGroups,
    AddUri { uri: String },
}

#[derive(Deserialize)]
struct Request {
    id: Value,
    /// Token nhận được khi ghép đôi.
    #[serde(default)]
    token: Option<String>,
    #[serde(flatten)]
    command: Command,
}

/// Trạng thái dùng chung của IPC server.
#[derive(Clone)]
pub struct Context {
    pub vault: SharedVault,
    pub pairing: SharedPairing,
    pub app: AppHandle,
}

pub fn error_response(id: Value, error: &AppError) -> Value {
    json!({ "id": id, "ok": false, "error": error })
}

fn handle_line(line: &str, ctx: &Context) -> Value {
    let request: Request = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(e) => {
            let id = serde_json::from_str::<Value>(line)
                .ok()
                .and_then(|v| v.get("id").cloned())
                .unwrap_or(Value::Null);
            return error_response(id, &AppError::bad_request(e.to_string()));
        }
    };
    match execute(request.command, request.token.as_deref(), ctx) {
        Ok(data) => json!({ "id": request.id, "ok": true, "data": data }),
        Err(e) => error_response(request.id, &e),
    }
}

fn execute(command: Command, token: Option<&str>, ctx: &Context) -> AppResult<Value> {
    match command {
        Command::Ping => return Ok(json!({ "version": env!("CARGO_PKG_VERSION") })),
        Command::PairRequest { request_id, name } => {
            let (request, new) = ctx.pairing.request(&request_id, &name)?;
            if new {
                crate::app::show_main_window(&ctx.app);
                let _ = ctx.app.emit(PAIR_REQUEST_EVENT, &request);
            }
            return Ok(serde_json::to_value(request)?);
        }
        Command::PairStatus { request_id } => {
            return Ok(serde_json::to_value(ctx.pairing.status(&request_id)?)?);
        }
        _ => ctx.pairing.verify(token)?,
    }

    let mut vault = ctx
        .vault
        .lock()
        .map_err(|_| AppError::internal("vault mutex poisoned"))?;
    match command {
        Command::Status => Ok(serde_json::to_value(vault.status())?),
        Command::ListCodes => Ok(serde_json::to_value(vault.codes()?)?),
        Command::ListGroups => Ok(serde_json::to_value(vault.groups()?)?),
        Command::AddUri { uri } => {
            let result = vault.import_uri(&uri)?;
            drop(vault);
            let _ = ctx.app.emit(VAULT_CHANGED_EVENT, ());
            Ok(serde_json::to_value(result)?)
        }
        Command::Ping | Command::PairRequest { .. } | Command::PairStatus { .. } => {
            unreachable!("đã xử lý ở trên")
        }
    }
}

#[cfg(windows)]
pub async fn serve(ctx: Context) -> std::io::Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::windows::named_pipe::ServerOptions;

    // first_pipe_instance: thất bại nếu đã có tiến trình khác giữ pipe này.
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(PIPE_NAME)?;

    loop {
        server.connect().await?;
        let client = server;
        server = ServerOptions::new().create(PIPE_NAME)?;

        let ctx = ctx.clone();
        tauri::async_runtime::spawn(async move {
            let (reader, mut writer) = tokio::io::split(client);
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut out = serde_json::to_vec(&handle_line(&line, &ctx))
                    .unwrap_or_default();
                out.push(b'\n');
                if writer.write_all(&out).await.is_err() {
                    break;
                }
            }
        });
    }
}

#[cfg(not(windows))]
pub async fn serve(_ctx: Context) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "named pipe chỉ hỗ trợ Windows",
    ))
}
