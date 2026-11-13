import type { AppError, CodeEntry, Group, ImportResult, VaultStatus } from "./types";

/** Tên native messaging host, phải khớp với desktop/src-tauri/src/register.rs. */
export const NATIVE_HOST_NAME = "com.authenticator.app";

/** Message extension -> native host -> desktop app. */
export type NativeCommand =
  | { type: "ping" }
  /**
   * Xin ghép đôi: app desktop hiện hộp thoại kèm `code` để người dùng cho phép. `requestId` do
   * extension tự tạo và lưu trước khi gửi (popup đóng ngay khi app bật lên).
   */
  | { type: "pair_request"; requestId: string; name: string }
  | { type: "pair_status"; requestId: string }
  | { type: "status" }
  | { type: "list_codes" }
  | { type: "list_groups" }
  | { type: "add_uri"; uri: string };

/** `token`: nhận được khi ghép đôi; bắt buộc trừ ping / pair_request / pair_status. */
export type NativeRequest = NativeCommand & { id: number; token?: string };

export interface PairRequestResult {
  requestId: string;
  /** 6 số dạng "123 456", hiện giống nhau ở popup và app desktop. */
  code: string;
  name: string;
}

export type PairStatusResult =
  | { status: "pending"; code: string }
  | { status: "approved"; token: string }
  | { status: "denied" }
  | { status: "expired" };

export interface NativeResultMap {
  ping: { version: string };
  pair_request: PairRequestResult;
  pair_status: PairStatusResult;
  status: VaultStatus;
  list_codes: CodeEntry[];
  list_groups: Group[];
  add_uri: ImportResult;
}

export type NativeResponse<T = unknown> =
  | { id: number; ok: true; data: T }
  | { id: number; ok: false; error: AppError };
