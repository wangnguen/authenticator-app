import type { Algorithm, NewAccount } from "@auth/core";

/**
 * Dữ liệu vault, giống hệt `Account` / `Deleted` / `VaultData` trong
 * desktop/src-tauri/src/vault.rs (serde camelCase) để đọc/ghi chung bản sao lưu trên Drive.
 */
export interface Account {
  id: string;
  issuer: string;
  label: string;
  /** Base32 đã chuẩn hoá (in hoa, không padding). */
  secret: string;
  algorithm: Algorithm;
  digits: number;
  period: number;
  /** Unix ms. */
  createdAt: number;
  /** Unix ms; vault cũ không có thì coi như bằng `createdAt`. */
  updatedAt?: number;
}

export interface Deleted {
  id: string;
  deletedAt: number;
  /** Không có: đã xoá vĩnh viễn. */
  account?: Account;
}

export interface VaultData {
  accounts: Account[];
  deleted: Deleted[];
}

export function changedAt(account: Account): number {
  return Math.max(account.updatedAt ?? 0, account.createdAt);
}

export interface ParsedAccounts {
  accounts: NewAccount[];
  /** Số tài khoản chưa hỗ trợ (HOTP, MD5). */
  unsupported: number;
}

/** Lỗi có mã, cùng mã với app desktop để popup hiển thị giống nhau. */
export class VaultError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
