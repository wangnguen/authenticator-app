//! Chế độ native messaging host: Chrome/Edge chạy exe này với stdin/stdout,
//! mỗi message có tiền tố 4 byte độ dài (native byte order) + JSON.
//! Host không đọc vault, chỉ chuyển tiếp message sang app đang chạy qua named pipe,
//! nên secret không bao giờ rời khỏi tiến trình app desktop.

use crate::ipc::PIPE_NAME;
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::time::Duration;

const MAX_MESSAGE_LEN: usize = 4 * 1024 * 1024;
const ERROR_PIPE_BUSY: i32 = 231;

pub fn is_native_host_launch() -> bool {
    std::env::args()
        .skip(1)
        .any(|arg| arg.starts_with("chrome-extension://"))
}

pub fn run() {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let mut connection: Option<Connection> = None;

    while let Ok(Some(message)) = read_message(&mut input) {
        let response = match serde_json::from_slice::<Value>(&message) {
            Ok(request) => forward(&mut connection, &request)
                .unwrap_or_else(|_| app_not_running(&request)),
            Err(e) => error(Value::Null, "BAD_REQUEST", &e.to_string()),
        };
        if write_message(&mut output, &response).is_err() {
            break;
        }
    }
}

fn forward(connection: &mut Option<Connection>, request: &Value) -> io::Result<Value> {
    // Thử lại một lần với kết nối mới nếu app vừa khởi động lại.
    let mut last_error = None;
    for _ in 0..2 {
        if connection.is_none() {
            *connection = Some(Connection::open()?);
        }
        match connection.as_mut().unwrap().roundtrip(request) {
            Ok(response) => return Ok(response),
            Err(e) => {
                *connection = None;
                last_error = Some(e);
            }
        }
    }
    Err(last_error.unwrap())
}

fn app_not_running(request: &Value) -> Value {
    error(
        request.get("id").cloned().unwrap_or(Value::Null),
        "APP_NOT_RUNNING",
        "App Authenticator trên máy chưa chạy.",
    )
}

fn error(id: Value, code: &str, message: &str) -> Value {
    json!({ "id": id, "ok": false, "error": { "code": code, "message": message } })
}

struct Connection {
    reader: BufReader<File>,
    writer: File,
}

impl Connection {
    fn open() -> io::Result<Self> {
        let mut attempts = 0;
        let file = loop {
            match OpenOptions::new().read(true).write(true).open(PIPE_NAME) {
                Ok(file) => break file,
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && attempts < 20 => {
                    attempts += 1;
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => return Err(e),
            }
        };
        Ok(Self {
            reader: BufReader::new(file.try_clone()?),
            writer: file,
        })
    }

    fn roundtrip(&mut self, request: &Value) -> io::Result<Value> {
        let mut line = serde_json::to_vec(request)?;
        line.push(b'\n');
        self.writer.write_all(&line)?;
        self.writer.flush()?;

        let mut response = String::new();
        if self.reader.read_line(&mut response)? == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        Ok(serde_json::from_str(&response)?)
    }
}

fn read_message(input: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match input.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_ne_bytes(len) as usize;
    if len > MAX_MESSAGE_LEN {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "message quá lớn"));
    }
    let mut buf = vec![0u8; len];
    input.read_exact(&mut buf)?;
    Ok(Some(buf))
}

fn write_message(output: &mut impl Write, value: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(value)?;
    output.write_all(&(bytes.len() as u32).to_ne_bytes())?;
    output.write_all(&bytes)?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_framing_roundtrip() {
        let mut buf = Vec::new();
        write_message(&mut buf, &json!({ "id": 1, "type": "ping" })).unwrap();
        let mut cursor = io::Cursor::new(buf);
        let message = read_message(&mut cursor).unwrap().unwrap();
        let value: Value = serde_json::from_slice(&message).unwrap();
        assert_eq!(value["type"], "ping");
        assert!(read_message(&mut cursor).unwrap().is_none());
    }
}
