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
  | "INTERNAL";

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
