import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CodeEntry, NewAccount, VaultStatus } from "@auth/core";

export interface AccountSummary {
  id: string;
  issuer: string;
  label: string;
}

export interface ExtensionInfo {
  hostName: string;
  extensionId: string;
  manifestPath: string | null;
  error: string | null;
}

/** Wrapper cho các Tauri command trong src-tauri/src/commands.rs. */
export const api = {
  status: () => invoke<VaultStatus>("vault_status"),
  createVault: (password: string) => invoke<void>("create_vault", { password }),
  unlockVault: (password: string) => invoke<void>("unlock_vault", { password }),
  lockVault: () => invoke<void>("lock_vault"),
  listCodes: () => invoke<CodeEntry[]>("list_codes"),
  addAccount: (account: NewAccount) =>
    invoke<AccountSummary>("add_account", { account }),
  addAccountUri: (uri: string) =>
    invoke<AccountSummary>("add_account_uri", { uri }),
  deleteAccount: (id: string) => invoke<void>("delete_account", { id }),
  extensionInfo: () => invoke<ExtensionInfo>("extension_info"),
  /** Extension vừa thêm tài khoản (qua quét QR). */
  onVaultChanged: (callback: () => void) => listen("vault-changed", callback),
};
