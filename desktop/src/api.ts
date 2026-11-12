import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AccountSummary,
  BackupInfo,
  GoogleProfile,
  CodeEntry,
  ImportPreview,
  ImportResult,
  NewAccount,
  RestorePreview,
  SyncPreview,
  SyncResult,
  TrashEntry,
  VaultStatus,
} from "@auth/core";

/** Extension được nhúng trong app để "Load unpacked" (khi chưa có trên Store). */
export interface ExtensionPackage {
  bundled: boolean;
  version: string | null;
  /** Thư mục đã giải nén; null nếu chưa giải nén. */
  path: string | null;
}

export type BrowserName = "chrome" | "edge";

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
  /** Chuyển vào Thùng rác. */
  deleteAccount: (id: string) => invoke<void>("delete_account", { id }),
  listTrash: () => invoke<TrashEntry[]>("list_trash"),
  restoreDeleted: (id: string) => invoke<AccountSummary>("restore_deleted", { id }),
  /** Xoá vĩnh viễn khỏi Thùng rác. */
  purgeDeleted: (id: string) => invoke<void>("purge_deleted", { id }),
  extensionInfo: () => invoke<ExtensionInfo>("extension_info"),
  extensionPackage: () => invoke<ExtensionPackage>("extension_package"),
  /** Giải nén extension rồi mở trang chrome://extensions (hoặc edge://extensions). */
  installExtension: (browser: BrowserName) =>
    invoke<{ package: ExtensionPackage; browserError: string | null }>("install_extension", {
      browser,
    }),
  openExtensionFolder: () => invoke<void>("open_extension_folder"),

  googleAccount: () => invoke<GoogleProfile | null>("google_account"),
  /** Mở trình duyệt để đăng nhập, resolve khi đăng nhập xong. */
  googleSignIn: () => invoke<GoogleProfile>("google_sign_in"),
  googleSignOut: () => invoke<void>("google_sign_out"),
  googleBackupInfo: () => invoke<BackupInfo | null>("google_backup_info"),
  /** Xem trước đồng bộ. `backupPassword` chỉ cần khi bản sao lưu dùng master password khác. */
  googleSyncPreview: (backupPassword: string | null) =>
    invoke<SyncPreview>("google_sync_preview", { backupPassword }),
  /**
   * Đồng bộ 2 chiều; chỉ xoá các tài khoản có id trong `confirmedDeletions`.
   * `backupVersion` lấy từ bản xem trước; bản trên Drive đã đổi thì lỗi BACKUP_CHANGED.
   */
  googleSync: (
    backupPassword: string | null,
    confirmedDeletions: string[],
    backupVersion: string | null,
  ) => invoke<SyncResult>("google_sync", { backupPassword, confirmedDeletions, backupVersion }),
  googleRestorePreview: () => invoke<RestorePreview>("google_restore_preview"),
  /** Mở thư mục "Authenticator Backup" trên Google Drive bằng trình duyệt. */
  googleOpenBackupFolder: () => invoke<void>("google_open_backup_folder"),
  /** Thay vault trên máy bằng bản sao lưu (vault cũ giữ trong thư mục history). */
  /** `backupVersion` từ googleRestorePreview (null ở màn hình tạo vault). */
  googleRestore: (backupVersion: string | null) =>
    invoke<void>("google_restore", { backupVersion }),
  /** Extension vừa thêm tài khoản (qua quét QR). */
  onVaultChanged: (callback: () => void) => listen("vault-changed", callback),
};
