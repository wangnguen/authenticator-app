export type Algorithm = "SHA1" | "SHA256" | "SHA512";

/** Mã OTP hiện tại của một tài khoản (không bao giờ chứa secret). */
export interface CodeEntry {
  id: string;
  issuer: string;
  label: string;
  code: string;
  digits: number;
  period: number;
  /** Thời điểm mã hết hạn (Unix ms). */
  expiresAt: number;
}

export interface NewAccount {
  issuer: string;
  label: string;
  secret: string;
  algorithm: Algorithm;
  digits: number;
  period: number;
}

export interface AccountSummary {
  id: string;
  issuer: string;
  label: string;
}

/** Kết quả import từ link otpauth:// hoặc otpauth-migration://. */
export interface ImportResult {
  added: AccountSummary[];
  /** Bỏ qua vì đã có trong vault. */
  duplicates: number;
  /** Bỏ qua vì chưa hỗ trợ (HOTP, MD5). */
  unsupported: number;
}

/** Tài khoản đọc được từ link/QR, hiển thị trước khi bấm "Thêm" (không có secret). */
export interface AccountPreview {
  issuer: string;
  label: string;
  algorithm: Algorithm;
  digits: number;
  period: number;
  /** Đã có trong vault, sẽ bị bỏ qua. */
  duplicate: boolean;
}

export interface ImportPreview {
  accounts: AccountPreview[];
  /** Số tài khoản chưa hỗ trợ (HOTP, MD5), sẽ bị bỏ qua. */
  unsupported: number;
}

export interface GoogleProfile {
  email: string;
  name: string;
  picture: string | null;
}

/** Bản sao lưu vault trên Google Drive. */
export interface BackupInfo {
  /** RFC 3339. */
  modifiedTime: string | null;
  size: number | null;
}

/** Tài khoản bị xoá ở một bên, chỉ xoá khi người dùng xác nhận. */
export interface PendingDeletion {
  id: string;
  issuer: string;
  label: string;
  /**
   * "local": đang có trên máy này, máy khác đã xoá.
   * "remote": còn trong bản sao lưu, máy này đã xoá.
   */
  side: "local" | "remote";
  /** Unix ms. */
  deletedAt: number;
  /** Bên kia đã xoá vĩnh viễn: đồng ý xoá thì không còn trong Thùng rác. */
  permanent: boolean;
}

/** Xem trước đồng bộ với Google Drive. */
export interface SyncPreview {
  /** Phiên bản (thời điểm sửa) của bản sao lưu đã xem; null: chưa có bản nào. */
  backupVersion: string | null;
  backupExists: boolean;
  /** Máy này và Drive đã giống nhau (tự đồng bộ thì bỏ qua). */
  inSync: boolean;
  /** Tài khoản sẽ được thêm vào máy này. */
  added: AccountSummary[];
  /** Tài khoản chỉ có trên máy này, sẽ được đưa lên bản sao lưu. */
  uploaded: AccountSummary[];
  pendingDeletions: PendingDeletion[];
  warnings: string[];
}

export interface SyncResult {
  added: number;
  uploaded: number;
  deleted: number;
  kept: number;
  backup: BackupInfo;
}

/** So sánh trước khi khôi phục (thay toàn bộ vault trên máy). */
export interface RestorePreview {
  /** Phiên bản (thời điểm sửa) của bản sao lưu đã so sánh. */
  backupVersion: string;
  localCount: number;
  /** null: bản sao lưu dùng master password khác, chưa đọc được. */
  backupCount: number | null;
  /** Tài khoản trên máy không có trong bản sao lưu. null: không so sánh được. */
  missing: AccountSummary[] | null;
  warnings: string[];
}

/** Tài khoản trong Thùng rác (không có secret). */
export interface TrashEntry {
  id: string;
  issuer: string;
  label: string;
  /** Unix ms. */
  deletedAt: number;
}

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
  /** false: vault không có master password, tự mở khoá bằng tài khoản Windows. */
  hasPassword: boolean;
}

export const MIN_PASSWORD_LENGTH = 8;

export interface AppError {
  code: ErrorCode;
  message: string;
}

export type ErrorCode =
  | "VAULT_EXISTS"
  | "NO_VAULT"
  | "LOCKED"
  | "WRONG_PASSWORD"
  | "WEAK_PASSWORD"
  | "INVALID_URI"
  | "INVALID_ACCOUNT"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "APP_NOT_RUNNING"
  | "INVALID_BACKUP"
  | "NO_BACKUP"
  | "BACKUP_PASSWORD"
  | "BACKUP_CHANGED"
  | "NOT_PAIRED"
  | "PAIR_EXPIRED"
  | "PAIR_BUSY"
  | "NETWORK"
  | "GOOGLE_API"
  | "GOOGLE_AUTH"
  | "GOOGLE_CANCELLED"
  | "GOOGLE_NOT_CONFIGURED"
  | "GOOGLE_SESSION_EXPIRED"
  | "GOOGLE_SIGNED_OUT"
  | "GOOGLE_TIMEOUT"
  | "INTERNAL";

/** Extension đã được cho phép lấy mã (không có token). */
export interface PairedExtension {
  id: string;
  name: string;
  /** Unix ms. */
  createdAt: number;
  lastUsedAt: number;
}

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value
  );
}

export function errorMessage(value: unknown): string {
  if (isAppError(value)) return value.message;
  if (value instanceof Error) return value.message;
  return String(value);
}
