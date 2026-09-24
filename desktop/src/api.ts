import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AccountSummary,
  CodeEntry,
  ImportPreview,
  ImportResult,
  NewAccount,
  VaultStatus,
} from "@auth/core";

export interface ExtensionInfo {
  hostName: string;
  extensionId: string;
  manifestPath: string | null;
  error: string | null;
}

/** Wrapper cho các Tauri command trong src-tauri/src/commands.rs. */
export const api = {
  status: () => invoke<VaultStatus>("vault_status"),
  /** `password = null`: vault không mật khẩu, tự mở khoá bằng tài khoản Windows. */
  createVault: (password: string | null) => invoke<void>("create_vault", { password }),
  unlockVault: (password: string | null) => invoke<void>("unlock_vault", { password }),
  lockVault: () => invoke<void>("lock_vault"),
  /** Đặt/đổi mật khẩu, hoặc bỏ mật khẩu khi `newPassword = null`. */
  setPassword: (currentPassword: string | null, newPassword: string | null) =>
    invoke<void>("set_password", { currentPassword, newPassword }),
  listCodes: () => invoke<CodeEntry[]>("list_codes"),
  addAccount: (account: NewAccount) =>
    invoke<AccountSummary>("add_account", { account }),
  /** Nhận otpauth:// hoặc otpauth-migration:// (export Google Authenticator), nhiều link mỗi dòng một link. */
  importUri: (uri: string) => invoke<ImportResult>("import_uri", { uri }),
  /** Đọc thử link (giống importUri) nhưng không lưu, để hiện popup xem trước. */
  previewUri: (uri: string) => invoke<ImportPreview>("preview_uri", { uri }),
  deleteAccount: (id: string) => invoke<void>("delete_account", { id }),
  extensionInfo: () => invoke<ExtensionInfo>("extension_info"),
  /** Extension vừa thêm tài khoản (qua quét QR). */
  onVaultChanged: (callback: () => void) => listen("vault-changed", callback),
};
