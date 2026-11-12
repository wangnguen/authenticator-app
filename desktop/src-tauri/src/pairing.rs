//! Ghép đôi (pairing) extension với app desktop.
//!
//! Extension ID cố định nhờ `key` công khai trong manifest, nên extension khác (hoặc tiến trình
//! khác mở named pipe) có thể giả làm extension. Vì vậy mỗi extension phải được người dùng cho
//! phép trong app một lần:
//! 1. Extension tự tạo `requestId`, lưu lại (popup sẽ đóng khi app bật lên), rồi gửi
//!    `pair_request`; app trả mã 6 số để popup hiện.
//! 2. App hiện hộp thoại kèm cùng mã đó; người dùng bấm Cho phép / Từ chối.
//! 3. Extension hỏi `pair_status`; được duyệt thì nhận token (chỉ trả một lần, lúc đó mới thêm vào
//!    danh sách đã cho phép) và gửi kèm mọi request sau. App chỉ lưu SHA-256 của token, thu hồi
//!    được trong hộp thoại Kết nối extension.

use crate::error::{AppError, AppResult};
use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::OsRng;
use data_encoding::{BASE64URL_NOPAD, HEXLOWER};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub type SharedPairing = Arc<Pairing>;

/// Yêu cầu ghép đôi hết hạn nếu không được duyệt trong khoảng này.
const REQUEST_TTL: Duration = Duration::from_secs(120);
/// Đã duyệt nhưng extension chưa lấy token (popup chưa mở lại) thì giữ token trong khoảng này.
const CLAIM_TTL: Duration = Duration::from_secs(600);
/// Trong khoảng này không cho yêu cầu khác thay yêu cầu đang chờ (chống spam bật cửa sổ).
const REPLACE_AFTER: Duration = Duration::from_secs(30);
/// Chỉ ghi lại thời điểm dùng gần nhất khi đã cũ hơn khoảng này, để không ghi file mỗi request.
const LAST_USED_RESOLUTION_MS: u64 = 60 * 60 * 1000;
const FILE_NAME: &str = "paired-extensions.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredClient {
    id: String,
    name: String,
    created_at: u64,
    last_used_at: u64,
    /// SHA-256 (hex) của token.
    token_hash: String,
}

/// Extension đã ghép đôi (không có token).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedClient {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub last_used_at: u64,
}

/// Yêu cầu ghép đôi đang chờ, gửi cho giao diện app.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    pub request_id: String,
    /// 6 số, hiện giống nhau ở popup extension và app.
    pub code: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum PairStatus {
    /// Kèm mã để popup mở lại vẫn hiện được.
    Pending { code: String },
    Approved { token: String },
    Denied,
    /// Hết hạn, bị thay bằng yêu cầu khác, hoặc token đã được lấy.
    Expired,
}

enum Decision {
    Waiting,
    Approved(String),
    Denied,
}

struct Pending {
    request: PairRequest,
    created: Instant,
    decision: Decision,
}

impl Pending {
    fn expired(&self) -> bool {
        let ttl = match self.decision {
            Decision::Approved(_) => CLAIM_TTL,
            _ => REQUEST_TTL,
        };
        self.created.elapsed() >= ttl
    }

    fn waiting(&self) -> bool {
        matches!(self.decision, Decision::Waiting) && !self.expired()
    }
}

struct Inner {
    clients: Vec<StoredClient>,
    pending: Option<Pending>,
}

pub struct Pairing {
    path: PathBuf,
    inner: Mutex<Inner>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

fn hash(token: &str) -> String {
    HEXLOWER.encode(&Sha256::digest(token.as_bytes()))
}

pub fn not_paired() -> AppError {
    AppError::new(
        "NOT_PAIRED",
        "Extension chưa được kết nối với app. Bấm \"Kết nối với app\" rồi cho phép trong app desktop.",
    )
}

fn valid_request_id(id: &str) -> bool {
    (16..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl Pairing {
    pub fn load(dir: PathBuf) -> Self {
        let path = dir.join(FILE_NAME);
        let clients = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            path,
            inner: Mutex::new(Inner {
                clients,
                pending: None,
            }),
        }
    }

    fn lock(&self) -> AppResult<MutexGuard<'_, Inner>> {
        self.inner
            .lock()
            .map_err(|_| AppError::internal("pairing mutex poisoned"))
    }

    /// Gọi khi đang giữ khoá, để các lần ghi không chồng lên nhau.
    fn save(&self, clients: &[StoredClient]) -> AppResult<()> {
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(clients)?)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    /// Kiểm tra token của extension. Sai hoặc thiếu thì trả `NOT_PAIRED`.
    pub fn verify(&self, token: Option<&str>) -> AppResult<()> {
        let token = token.ok_or_else(not_paired)?;
        let token_hash = hash(token);
        let mut inner = self.lock()?;
        let client = inner
            .clients
            .iter_mut()
            .find(|c| c.token_hash == token_hash)
            .ok_or_else(not_paired)?;
        let now = now_ms();
        if now.saturating_sub(client.last_used_at) > LAST_USED_RESOLUTION_MS {
            client.last_used_at = now;
            // Không ghi được thời điểm dùng thì vẫn cho qua.
            let _ = self.save(&inner.clients);
        }
        Ok(())
    }

    /// Tạo yêu cầu ghép đôi. Trả `(yêu cầu, có phải yêu cầu mới)`: gửi lại cùng `request_id`
    /// thì trả yêu cầu cũ. Yêu cầu khác đang chờ (chưa quá `REPLACE_AFTER`) thì báo bận.
    pub fn request(&self, request_id: &str, name: &str) -> AppResult<(PairRequest, bool)> {
        if !valid_request_id(request_id) {
            return Err(AppError::bad_request("requestId không hợp lệ."));
        }
        let mut inner = self.lock()?;
        if let Some(pending) = &inner.pending {
            if pending.request.request_id == request_id && !pending.expired() {
                return Ok((pending.request.clone(), false));
            }
            if pending.waiting() && pending.created.elapsed() < REPLACE_AFTER {
                return Err(AppError::new(
                    "PAIR_BUSY",
                    "Đang có yêu cầu kết nối khác chờ xác nhận trong app desktop. Thử lại sau ít giây.",
                ));
            }
        }
        let code = u32::from_le_bytes(random_bytes::<4>()) % 1_000_000;
        let name = name.trim();
        let request = PairRequest {
            request_id: request_id.to_owned(),
            code: format!("{:03} {:03}", code / 1000, code % 1000),
            name: if name.is_empty() {
                "Extension".into()
            } else {
                name.chars().take(40).collect()
            },
        };
        inner.pending = Some(Pending {
            request: request.clone(),
            created: Instant::now(),
            decision: Decision::Waiting,
        });
        Ok((request, true))
    }

    /// Yêu cầu đang chờ người dùng quyết định (để giao diện hiện lại nếu lỡ sự kiện).
    pub fn pending(&self) -> AppResult<Option<PairRequest>> {
        let inner = self.lock()?;
        Ok(inner
            .pending
            .as_ref()
            .filter(|p| p.waiting())
            .map(|p| p.request.clone()))
    }

    /// Extension hỏi kết quả. Token chỉ được trả một lần; lúc đó extension mới được thêm vào
    /// danh sách đã cho phép (đã duyệt mà không bao giờ lấy token thì không để lại mục thừa).
    pub fn status(&self, request_id: &str) -> AppResult<PairStatus> {
        let mut inner = self.lock()?;
        let Some(pending) = inner
            .pending
            .as_ref()
            .filter(|p| p.request.request_id == request_id)
        else {
            return Ok(PairStatus::Expired);
        };
        let (status, client) = match &pending.decision {
            _ if pending.expired() => (PairStatus::Expired, None),
            Decision::Waiting => {
                return Ok(PairStatus::Pending {
                    code: pending.request.code.clone(),
                })
            }
            Decision::Approved(token) => {
                let now = now_ms();
                let client = StoredClient {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: pending.request.name.clone(),
                    created_at: now,
                    last_used_at: now,
                    token_hash: hash(token),
                };
                (
                    PairStatus::Approved {
                        token: token.clone(),
                    },
                    Some(client),
                )
            }
            Decision::Denied => (PairStatus::Denied, None),
        };
        inner.pending = None;
        if let Some(client) = client {
            inner.clients.push(client);
            self.save(&inner.clients)?;
        }
        Ok(status)
    }

    /// Người dùng trả lời yêu cầu trong app.
    pub fn decide(&self, request_id: &str, approve: bool) -> AppResult<()> {
        let mut inner = self.lock()?;
        let pending = inner
            .pending
            .as_mut()
            .filter(|p| p.request.request_id == request_id && p.waiting())
            .ok_or_else(|| {
                AppError::new("PAIR_EXPIRED", "Yêu cầu kết nối đã hết hạn. Hãy thử lại từ extension.")
            })?;
        pending.decision = if approve {
            Decision::Approved(BASE64URL_NOPAD.encode(&random_bytes::<32>()))
        } else {
            Decision::Denied
        };
        Ok(())
    }

    pub fn clients(&self) -> AppResult<Vec<PairedClient>> {
        Ok(self
            .lock()?
            .clients
            .iter()
            .map(|c| PairedClient {
                id: c.id.clone(),
                name: c.name.clone(),
                created_at: c.created_at,
                last_used_at: c.last_used_at,
            })
            .collect())
    }

    pub fn revoke(&self, id: &str) -> AppResult<()> {
        let mut inner = self.lock()?;
        let before = inner.clients.len();
        inner.clients.retain(|c| c.id != id);
        if inner.clients.len() == before {
            return Err(AppError::not_found());
        }
        self.save(&inner.clients)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIRST: &str = "request-0000000001";
    const SECOND: &str = "request-0000000002";

    fn temp() -> (Pairing, PathBuf) {
        let dir = std::env::temp_dir().join(format!("auth-pair-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        (Pairing::load(dir.clone()), dir)
    }

    #[test]
    fn approve_flow_issues_token_once() {
        let (pairing, dir) = temp();
        assert_eq!(pairing.verify(None).unwrap_err().code, "NOT_PAIRED");
        assert_eq!(pairing.request("ngắn", "Chrome").unwrap_err().code, "BAD_REQUEST");

        let (request, new) = pairing.request(FIRST, "Chrome").unwrap();
        assert!(new && request.code.len() == 7);
        // Popup mở lại gửi cùng requestId: nhận lại đúng yêu cầu, không tạo mới.
        let (again, new) = pairing.request(FIRST, "Chrome").unwrap();
        assert!(!new && again.code == request.code);
        let PairStatus::Pending { code } = pairing.status(FIRST).unwrap() else {
            panic!("phải đang chờ");
        };
        assert_eq!(code, request.code);
        assert_eq!(pairing.pending().unwrap().unwrap().request_id, FIRST);

        pairing.decide(FIRST, true).unwrap();
        // Chưa lấy token thì chưa có trong danh sách.
        assert!(pairing.clients().unwrap().is_empty());
        let PairStatus::Approved { token } = pairing.status(FIRST).unwrap() else {
            panic!("chưa được duyệt");
        };
        // Token chỉ lấy được một lần.
        assert!(matches!(pairing.status(FIRST).unwrap(), PairStatus::Expired));
        pairing.verify(Some(&token)).unwrap();
        assert_eq!(pairing.verify(Some("sai")).unwrap_err().code, "NOT_PAIRED");

        // Lưu xuống file (chỉ hash) và thu hồi được.
        let reloaded = Pairing::load(dir.clone());
        reloaded.verify(Some(&token)).unwrap();
        assert!(!fs::read_to_string(dir.join(FILE_NAME)).unwrap().contains(&token));
        let id = reloaded.clients().unwrap()[0].id.clone();
        reloaded.revoke(&id).unwrap();
        assert_eq!(reloaded.verify(Some(&token)).unwrap_err().code, "NOT_PAIRED");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn busy_and_denied_requests() {
        let (pairing, dir) = temp();
        pairing.request(FIRST, "Chrome").unwrap();
        // Yêu cầu khác không thay được yêu cầu vừa tạo (chống spam bật cửa sổ).
        assert_eq!(pairing.request(SECOND, "Edge").unwrap_err().code, "PAIR_BUSY");
        assert!(matches!(pairing.status(SECOND).unwrap(), PairStatus::Expired));

        pairing.decide(FIRST, false).unwrap();
        assert_eq!(pairing.decide(FIRST, true).unwrap_err().code, "PAIR_EXPIRED");
        assert!(matches!(pairing.status(FIRST).unwrap(), PairStatus::Denied));
        assert!(pairing.clients().unwrap().is_empty());
        // Đã có kết quả thì yêu cầu mới được tạo ngay.
        assert!(pairing.request(SECOND, "Edge").unwrap().1);
        let _ = fs::remove_dir_all(dir);
    }
}
