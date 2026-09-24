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

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
}

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
