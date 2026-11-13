import type { GoogleProfile } from "@auth/core";
import { VaultError } from "./types";

/**
 * Đăng nhập Google và đọc/ghi bản sao lưu trên Drive, dùng chung file với app desktop
 * (google.rs): `vault-backup.json` trong thư mục "Authenticator Backup", scope `drive.file`.
 *
 * Đăng nhập bằng `chrome.identity.launchWebAuthFlow` (chạy được cả Chrome lẫn Edge), luồng
 * implicit nên extension không cần client secret. Access token sống 1 giờ; hết hạn thì xin
 * lại ngầm (`prompt=none`) nhờ phiên Google đang đăng nhập trong trình duyệt.
 *
 * OAuth client loại "Web application" phải nằm cùng project Google Cloud với client của app
 * desktop: với scope `drive.file`, Drive chỉ cho thấy file do chính project đó tạo.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const SCOPES = `openid email profile ${DRIVE_SCOPE}`;
const BACKUP_NAME = "vault-backup.json";
const BACKUP_FOLDER_NAME = "Authenticator Backup";
const FOLDER_MIME = "application/vnd.google-apps.folder";
/** Đổi token trước khi hết hạn một chút. */
const EXPIRY_MARGIN_MS = 60_000;

const TOKEN_KEY = "googleToken";
const PROFILE_KEY = "googleProfile";

interface StoredToken {
  accessToken: string;
  expiresAt: number;
}

export const GOOGLE_CLIENT_ID: string = __GOOGLE_CLIENT_ID__;

export function googleConfigured(): boolean {
  return GOOGLE_CLIENT_ID.length > 0;
}

export async function googleProfile(): Promise<GoogleProfile | null> {
  const stored = await chrome.storage.local.get(PROFILE_KEY);
  return (stored[PROFILE_KEY] as GoogleProfile | undefined) ?? null;
}

const sessionExpired = () =>
  new VaultError(
    "GOOGLE_SESSION_EXPIRED",
    "Phiên đăng nhập Google đã hết hạn. Hãy đăng nhập lại trong extension.",
  );

/** Mở cửa sổ đăng nhập (`interactive`) hoặc xin token ngầm. */
async function authorize(interactive: boolean, loginHint?: string): Promise<StoredToken> {
  if (!googleConfigured()) {
    throw new VaultError(
      "GOOGLE_NOT_CONFIGURED",
      "Extension này được build khi chưa cấu hình OAuth Client ID (xem README, mục Extension đăng nhập Google).",
    );
  }
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    response_type: "token",
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: SCOPES,
    state,
    include_granted_scopes: "true",
    prompt: interactive ? "select_account" : "none",
  });
  if (loginHint) params.set("login_hint", loginHint);

  let redirect: string | undefined;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({
      url: `${AUTH_URL}?${params}`,
      interactive,
      // Trang của Google tự chuyển hướng bằng JS, phải chờ thay vì dừng ngay khi tải xong.
      ...(interactive ? {} : { abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 10_000 }),
    } as chrome.identity.WebAuthFlowDetails);
  } catch (e) {
    if (!interactive) throw sessionExpired();
    const message = e instanceof Error ? e.message : String(e);
    throw new VaultError(
      "GOOGLE_CANCELLED",
      /cancel|closed|did not approve/i.test(message) ? "Đã huỷ đăng nhập Google." : message,
    );
  }
  if (!redirect) throw sessionExpired();

  const result = new URLSearchParams(new URL(redirect).hash.slice(1));
  if (result.get("state") !== state) throw new VaultError("GOOGLE_AUTH_FAILED", "Phản hồi đăng nhập không hợp lệ.");
  const error = result.get("error");
  if (error) {
    if (!interactive) throw sessionExpired();
    throw new VaultError(
      error === "access_denied" ? "GOOGLE_CANCELLED" : "GOOGLE_AUTH_FAILED",
      error === "access_denied" ? "Đã huỷ đăng nhập Google." : `Google báo lỗi: ${error}`,
    );
  }
  const accessToken = result.get("access_token");
  if (!accessToken) throw new VaultError("GOOGLE_AUTH_FAILED", "Google không trả về access token.");
  const granted = (result.get("scope") ?? "").split(/\s+/);
  if (!granted.includes(DRIVE_SCOPE)) {
    throw new VaultError(
      "GOOGLE_SCOPE_DENIED",
      "Cần cho phép quyền Google Drive (ô \"xem, tạo và xoá các tệp Google Drive cụ thể\") để đồng bộ.",
    );
  }
  const token = {
    accessToken,
    expiresAt: Date.now() + Number(result.get("expires_in") ?? "3600") * 1000,
  };
  await chrome.storage.session.set({ [TOKEN_KEY]: token });
  return token;
}

export async function signIn(): Promise<GoogleProfile> {
  const token = await authorize(true);
  const response = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
  });
  if (!response.ok) throw await googleError(response);
  const info = (await response.json()) as { email?: string; name?: string; picture?: string };
  const profile: GoogleProfile = {
    email: info.email ?? "",
    name: info.name ?? info.email ?? "",
    picture: info.picture ?? null,
  };
  await chrome.storage.local.set({ [PROFILE_KEY]: profile });
  return profile;
}

export async function signOut(): Promise<void> {
  const stored = await chrome.storage.session.get(TOKEN_KEY);
  const token = stored[TOKEN_KEY] as StoredToken | undefined;
  await chrome.storage.session.remove(TOKEN_KEY);
  await chrome.storage.local.remove(PROFILE_KEY);
  if (token) {
    // Thu hồi quyền; lỗi mạng thì bỏ qua (token tự hết hạn sau 1 giờ).
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token.accessToken)}`, {
      method: "POST",
    }).catch(() => undefined);
  }
}

async function accessToken(): Promise<string> {
  const profile = await googleProfile();
  if (!profile) throw new VaultError("GOOGLE_SIGNED_OUT", "Chưa đăng nhập Google.");
  const stored = await chrome.storage.session.get(TOKEN_KEY);
  const token = stored[TOKEN_KEY] as StoredToken | undefined;
  if (token && token.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return token.accessToken;
  return (await authorize(false, profile.email)).accessToken;
}

async function googleError(response: Response): Promise<VaultError> {
  const body = await response.text().catch(() => "");
  if (response.status === 401) {
    await chrome.storage.session.remove(TOKEN_KEY);
    return sessionExpired();
  }
  if (response.status === 403 && /insufficient|scope/i.test(body)) {
    return new VaultError("GOOGLE_SCOPE_DENIED", "Thiếu quyền Google Drive. Hãy đăng xuất rồi đăng nhập lại.");
  }
  return new VaultError("GOOGLE_API", `Google Drive báo lỗi ${response.status}.`);
}

/** Gọi Drive API; token bị từ chối (401) thì xin token mới và thử lại một lần. */
async function drive(url: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken();
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
      });
    } catch {
      throw new VaultError("NETWORK", "Không kết nối được Google Drive. Kiểm tra mạng.");
    }
    if (response.ok) return response;
    if (response.status === 401 && attempt === 0) {
      await chrome.storage.session.remove(TOKEN_KEY);
      continue;
    }
    throw await googleError(response);
  }
}

interface DriveFile {
  id: string;
  modifiedTime?: string;
}

async function find(query: string): Promise<DriveFile | null> {
  const params = new URLSearchParams({
    q: query,
    fields: "files(id,modifiedTime)",
    orderBy: "modifiedTime desc",
  });
  const response = await drive(`${DRIVE_FILES_URL}?${params}`);
  const list = (await response.json()) as { files?: DriveFile[] };
  return list.files?.[0] ?? null;
}

/** Bản sao lưu ở bất kỳ đâu trong Drive (người dùng có thể đã chuyển sang thư mục khác). */
const findBackup = () =>
  find(`name = '${BACKUP_NAME}' and mimeType != '${FOLDER_MIME}' and trashed = false`);

async function ensureFolder(): Promise<DriveFile> {
  const folder = await find(
    `name = '${BACKUP_FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
  );
  if (folder) return folder;
  const response = await drive(`${DRIVE_FILES_URL}?fields=id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: BACKUP_FOLDER_NAME, mimeType: FOLDER_MIME }),
  });
  return (await response.json()) as DriveFile;
}

export interface RemoteBackup {
  text: string;
  /** Phiên bản (thời điểm sửa) để phát hiện máy khác ghi đè trong lúc gộp. */
  modifiedTime: string;
}

export async function fetchBackup(): Promise<RemoteBackup | null> {
  const file = await findBackup();
  if (!file) return null;
  const response = await drive(`${DRIVE_FILES_URL}/${file.id}?alt=media`);
  return { text: await response.text(), modifiedTime: file.modifiedTime ?? "" };
}

/**
 * Ghi đè bản sao lưu. `expected`: phiên bản đã tải về lúc gộp (`null`: lúc đó chưa có).
 * Máy khác vừa ghi bản mới thì dừng (`BACKUP_CHANGED`) để không đè mất thay đổi của máy đó.
 */
export async function uploadBackup(text: string, expected: string | null): Promise<string> {
  const current = await findBackup();
  if ((current ? (current.modifiedTime ?? "") : null) !== expected) {
    throw new VaultError(
      "BACKUP_CHANGED",
      "Bản sao lưu trên Drive vừa được máy khác cập nhật. Hãy đồng bộ lại.",
    );
  }
  let id = current?.id;
  if (!id) {
    const folder = await ensureFolder();
    const response = await drive(`${DRIVE_FILES_URL}?fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: BACKUP_NAME, parents: [folder.id], mimeType: "application/json" }),
    });
    id = ((await response.json()) as DriveFile).id;
  }
  const response = await drive(`${DRIVE_UPLOAD_URL}/${id}?uploadType=media&fields=id,modifiedTime`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: text,
  });
  return ((await response.json()) as DriveFile).modifiedTime ?? "";
}
