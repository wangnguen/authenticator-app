import type { AppError, CodeEntry, VaultStatus } from "./types";

/** Tên native messaging host, phải khớp với desktop/src-tauri/src/register.rs. */
export const NATIVE_HOST_NAME = "com.authenticator.app";

/** Message extension -> native host -> desktop app. */
export type NativeCommand =
  | { type: "ping" }
  | { type: "status" }
  | { type: "list_codes" }
  | { type: "add_uri"; uri: string };

export type NativeRequest = NativeCommand & { id: number };

export interface NativeResultMap {
  ping: { version: string };
  status: VaultStatus;
  list_codes: CodeEntry[];
  add_uri: { issuer: string; label: string };
}

export type NativeResponse<T = unknown> =
  | { id: number; ok: true; data: T }
  | { id: number; ok: false; error: AppError };
