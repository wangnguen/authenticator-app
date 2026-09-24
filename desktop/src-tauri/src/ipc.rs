//! Named pipe server: nhận request từ native host (extension) và trả kết quả.
//! Mỗi request/response là một dòng JSON.

use crate::error::{AppError, AppResult};
use crate::otpauth;
use crate::vault::SharedVault;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

pub const PIPE_NAME: &str = r"\\.\pipe\com.authenticator.app";
pub const VAULT_CHANGED_EVENT: &str = "vault-changed";

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Command {
    Ping,
    Status,
    ListCodes,
    AddUri { uri: String },
}

#[derive(Deserialize)]
struct Request {
    id: Value,
    #[serde(flatten)]
    command: Command,
}

pub fn error_response(id: Value, error: &AppError) -> Value {
    json!({ "id": id, "ok": false, "error": error })
}

fn handle_line(line: &str, vault: &SharedVault, app: &AppHandle) -> Value {
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
    match execute(request.command, vault, app) {
        Ok(data) => json!({ "id": request.id, "ok": true, "data": data }),
        Err(e) => error_response(request.id, &e),
    }
}

fn execute(command: Command, vault: &SharedVault, app: &AppHandle) -> AppResult<Value> {
    let mut vault = vault
        .lock()
        .map_err(|_| AppError::internal("vault mutex poisoned"))?;
    match command {
        Command::Ping => Ok(json!({ "version": env!("CARGO_PKG_VERSION") })),
        Command::Status => Ok(serde_json::to_value(vault.status())?),
        Command::ListCodes => Ok(serde_json::to_value(vault.codes()?)?),
        Command::AddUri { uri } => {
            let summary = vault.add(otpauth::parse(&uri)?)?;
            drop(vault);
            let _ = app.emit(VAULT_CHANGED_EVENT, ());
            Ok(serde_json::to_value(summary)?)
        }
    }
}

#[cfg(windows)]
pub async fn serve(vault: SharedVault, app: AppHandle) -> std::io::Result<()> {
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

        let vault = vault.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let (reader, mut writer) = tokio::io::split(client);
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut out = serde_json::to_vec(&handle_line(&line, &vault, &app))
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
pub async fn serve(_vault: SharedVault, _app: AppHandle) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "named pipe chỉ hỗ trợ Windows",
    ))
}
