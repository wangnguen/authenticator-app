import type { AccountSummary, CodeEntry, ImportResult, PendingDeletion } from "@auth/core";
import {
  type Backup,
  deriveKey,
  fromBase64,
  generateKdf,
  type KdfParams,
  MIN_PASSWORD_LEN,
  openFile,
  parseBackup,
  plainFile,
  sameData,
  sameKdf,
  sealFile,
  toBase64,
} from "./backup";
import { fetchBackup, uploadBackup } from "./google";
import { computeMerge, type Merge, pendingDeletions, resolveMerge, type SyncSummary } from "./merge";
import { buildAccount, codesFor, parseUris } from "./otp";
import { type VaultData, VaultError } from "./types";

/**
 * Vault riêng của extension (dùng khi không có app desktop), là bản sao của bản sao lưu trên
 * Google Drive, lưu trong `chrome.storage.local` đúng định dạng file trên Drive:
 * - bản sao lưu có master password → lưu bản mã hoá; key giải mã chỉ nằm trong
 *   `chrome.storage.session` (mất khi đóng trình duyệt), mở lại thì nhập master password.
 * - bản sao lưu không mật khẩu (từ vault không mật khẩu của app) → lưu JSON như trên Drive.
 */

const VAULT_KEY = "standaloneVault";
const SESSION_KEY = "standaloneKey";
const ATTENTION_KEY = "syncAttention";
const SYNC_LOCK = "authenticator-sync";

interface StoredVault {
  /** Nội dung file, cùng định dạng với `vault-backup.json` trên Drive. */
  file: string;
  /** Tăng mỗi lần ghi, để biết dữ liệu đổi trong lúc đang chờ xác nhận đồng bộ. */
  revision: number;
  /** Phiên bản bản sao lưu lần đồng bộ gần nhất. */
  backupVersion: string | null;
  /** `revision` lúc đồng bộ thành công gần nhất. */
  syncedRevision: number | null;
  lastSync: number | null;
}

interface SessionKey {
  key: string;
  salt: string;
}

type Protection = { kind: "plain" } | { kind: "password"; kdf: KdfParams; key: Uint8Array };

interface OpenVault {
  stored: StoredVault;
  data: VaultData;
  protection: Protection;
}

export type StandaloneStatus =
  | { state: "empty" }
  | { state: "locked" }
  | { state: "open"; hasPassword: boolean; lastSync: number | null; unsynced: boolean };

/** Việc cần người dùng làm sau lần tự đồng bộ (hiện chấm đỏ trên icon extension). */
export type Attention =
  | { kind: "review"; count: number }
  | { kind: "password" }
  | { kind: "signin" }
  | { kind: "error"; message: string };

async function readStored(): Promise<StoredVault | null> {
  const stored = await chrome.storage.local.get(VAULT_KEY);
  return (stored[VAULT_KEY] as StoredVault | undefined) ?? null;
}

async function sessionKey(kdf: KdfParams): Promise<Uint8Array | null> {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  const session = stored[SESSION_KEY] as SessionKey | undefined;
  return session && session.salt === kdf.salt ? fromBase64(session.key) : null;
}

async function rememberKey(protection: Protection): Promise<void> {
  if (protection.kind === "password") {
    const value: SessionKey = { key: toBase64(protection.key), salt: protection.kdf.salt };
    await chrome.storage.session.set({ [SESSION_KEY]: value });
  } else {
    await chrome.storage.session.remove(SESSION_KEY);
  }
}

async function openWith(backup: Backup, key: Uint8Array | null): Promise<OpenVault["data"] | null> {
  if (backup.kind === "plain") return backup.data;
  return key ? openFile(backup.file, key) : null;
}

/** Vault đang mở; `null` nếu chưa có hoặc đang khoá. */
async function openVault(): Promise<OpenVault | null> {
  const stored = await readStored();
  if (!stored) return null;
  const backup = parseBackup(stored.file);
  if (backup.kind === "plain") return { stored, data: backup.data, protection: { kind: "plain" } };
  const key = await sessionKey(backup.file.kdf);
  if (!key) return null;
  return {
    stored,
    data: await openFile(backup.file, key),
    protection: { kind: "password", kdf: backup.file.kdf, key },
  };
}

async function requireOpen(): Promise<OpenVault> {
  const vault = await openVault();
  if (!vault) throw new VaultError("VAULT_LOCKED", "Vault đang khoá.");
  return vault;
}

async function serialize(data: VaultData, protection: Protection): Promise<string> {
  return protection.kind === "plain"
    ? plainFile(data)
    : sealFile(data, protection.key, protection.kdf);
}

async function writeStored(stored: StoredVault): Promise<void> {
  await chrome.storage.local.set({ [VAULT_KEY]: stored });
}

export async function standaloneStatus(): Promise<StandaloneStatus> {
  const stored = await readStored();
  if (!stored) return { state: "empty" };
  const vault = await openVault();
  if (!vault) return { state: "locked" };
  return {
    state: "open",
    hasPassword: vault.protection.kind === "password",
    lastSync: stored.lastSync,
    unsynced: stored.syncedRevision !== stored.revision,
  };
}

export async function unlock(password: string): Promise<void> {
  const stored = await readStored();
  if (!stored) throw new VaultError("VAULT_NOT_FOUND", "Chưa có vault.");
  const backup = parseBackup(stored.file);
  if (backup.kind === "plain") return;
  const key = await deriveKey(password, backup.file.kdf);
  await openFile(backup.file, key);
  await rememberKey({ kind: "password", kdf: backup.file.kdf, key });
}

export async function lock(): Promise<void> {
  await chrome.storage.session.remove(SESSION_KEY);
}

/** Xoá vault của extension (khi đăng xuất Google). */
export async function forget(): Promise<void> {
  await chrome.storage.local.remove([VAULT_KEY, ATTENTION_KEY]);
  await chrome.storage.session.remove(SESSION_KEY);
  await setAttention(null);
}

export async function listCodes(): Promise<CodeEntry[]> {
  return codesFor((await requireOpen()).data.accounts);
}

/** Thêm tài khoản từ link (QR quét trên trang), bỏ qua tài khoản trùng secret. */
export async function importUris(input: string): Promise<ImportResult> {
  const parsed = parseUris(input);
  if (parsed.accounts.length === 0) {
    throw new VaultError("INVALID_URI", "Không có tài khoản TOTP nào để import (HOTP chưa được hỗ trợ).");
  }
  const accounts = parsed.accounts.map((a) => buildAccount(a));
  return navigator.locks.request(SYNC_LOCK, async () => {
    const vault = await requireOpen();
    const added: AccountSummary[] = [];
    let duplicates = 0;
    for (const account of accounts) {
      if (vault.data.accounts.some((a) => a.secret === account.secret)) {
        duplicates++;
        continue;
      }
      vault.data.accounts.push(account);
      added.push({ id: account.id, issuer: account.issuer, label: account.label });
    }
    if (added.length === 0) throw new VaultError("INVALID_ACCOUNT", "Tất cả tài khoản đã tồn tại.");
    await writeStored({
      ...vault.stored,
      file: await serialize(vault.data, vault.protection),
      revision: vault.stored.revision + 1,
    });
    return { added, duplicates, unsupported: parsed.unsupported };
  });
}

// ---------------------------------------------------------------- đồng bộ

export interface SyncPlan {
  /** Phiên bản bản sao lưu đã tải; `null`: Drive chưa có. */
  backupVersion: string | null;
  /** `revision` của vault extension lúc gộp. */
  revision: number;
  added: AccountSummary[];
  uploaded: AccountSummary[];
  pendingDeletions: PendingDeletion[];
}

/** Kết quả gộp chờ áp dụng (giữ trong bộ nhớ của popup, không lưu). */
export interface PreparedSync {
  plan: SyncPlan;
  merge: Merge;
  remote: VaultData | null;
  protection: Protection;
  /** Lần đầu: chỉ nhận dữ liệu từ Drive. */
  first: boolean;
}

export type FirstSync =
  /** Drive chưa có bản sao lưu: cần đặt master password để tạo vault mới. */
  | { kind: "create" }
  /** Bản sao lưu có master password: cần nhập để giải mã. */
  | { kind: "password" };

/**
 * Tải bản sao lưu và gộp với vault của extension (chưa ghi gì).
 * `password`: master password của bản sao lưu, khi nó khác với vault hiện có (đổi mật khẩu trên
 * app) hoặc lần đầu tải về. Thiếu thì lỗi `BACKUP_PASSWORD`.
 */
export async function prepareSync(password?: string): Promise<PreparedSync | FirstSync> {
  const local = await readStored();
  const vault = local ? await requireOpen() : null;
  const remote = await fetchBackup();

  if (!remote) {
    if (!vault) return { kind: "create" };
    return prepared(vault, null, null, vault.protection);
  }

  const backup = parseBackup(remote.text);
  let protection: Protection;
  if (backup.kind === "plain") {
    protection = { kind: "plain" };
  } else {
    const kdf = backup.file.kdf;
    let key =
      vault?.protection.kind === "password" && sameKdf(vault.protection.kdf, kdf)
        ? vault.protection.key
        : null;
    if (!key) {
      if (!password) {
        if (!vault) return { kind: "password" };
        throw new VaultError(
          "BACKUP_PASSWORD",
          "Bản sao lưu trên Drive dùng master password khác (đã đổi trên app). Hãy nhập master password mới.",
        );
      }
      key = await deriveKey(password, kdf);
    }
    protection = { kind: "password", kdf, key };
  }
  const remoteData = (await openWith(backup, protection.kind === "password" ? protection.key : null))!;
  if (!vault) {
    // Lần đầu: nhận nguyên dữ liệu trên Drive.
    const merge = computeMerge({ accounts: [], deleted: [] }, remoteData);
    return {
      plan: plan(merge, remote.modifiedTime, 0),
      merge,
      remote: remoteData,
      protection,
      first: true,
    };
  }
  return prepared(vault, remoteData, remote.modifiedTime, protection);
}

function plan(merge: Merge, backupVersion: string | null, revision: number): SyncPlan {
  return {
    backupVersion,
    revision,
    added: merge.added,
    uploaded: merge.uploaded,
    pendingDeletions: pendingDeletions(merge),
  };
}

function prepared(
  vault: OpenVault,
  remote: VaultData | null,
  backupVersion: string | null,
  protection: Protection,
): PreparedSync {
  // Drive chưa có bản nào: gộp với dữ liệu rỗng = đưa toàn bộ lên.
  const merge = computeMerge(vault.data, remote ?? { accounts: [], deleted: [] });
  return {
    plan: plan(merge, backupVersion, vault.stored.revision),
    merge,
    remote,
    protection,
    first: false,
  };
}

/**
 * Áp dụng kết quả gộp: chỉ xoá tài khoản trong `confirmed`, tải lên Drive nếu có thay đổi rồi
 * lưu vào extension. Dừng (`BACKUP_CHANGED`) nếu Drive hoặc extension đã đổi từ lúc gộp.
 */
export async function applySync(sync: PreparedSync, confirmed: string[]): Promise<SyncSummary> {
  return navigator.locks.request(SYNC_LOCK, async () => {
    const stored = await readStored();
    if ((stored?.revision ?? 0) !== sync.plan.revision || (!stored && !sync.first)) {
      throw new VaultError("BACKUP_CHANGED", "Dữ liệu vừa thay đổi. Hãy đồng bộ lại.");
    }
    const { data, summary } = resolveMerge(sync.merge, confirmed, Date.now());
    const file = await serialize(data, sync.protection);
    let backupVersion = sync.plan.backupVersion;
    const unchanged = sync.remote !== null && sameData(data, sync.remote);
    if (!unchanged) backupVersion = await uploadBackup(file, sync.plan.backupVersion);
    const revision = (stored?.revision ?? 0) + 1;
    await writeStored({
      file,
      revision,
      backupVersion,
      syncedRevision: revision,
      lastSync: Date.now(),
    });
    await rememberKey(sync.protection);
    await setAttention(null);
    return summary;
  });
}

/** Drive chưa có bản sao lưu: tạo vault mới (có master password) và tải lên. */
export async function createVault(password: string): Promise<void> {
  if (password.length < MIN_PASSWORD_LEN) {
    throw new VaultError("WEAK_PASSWORD", `Mật khẩu cần ít nhất ${MIN_PASSWORD_LEN} ký tự.`);
  }
  const kdf = generateKdf();
  const protection: Protection = { kind: "password", kdf, key: await deriveKey(password, kdf) };
  const data: VaultData = { accounts: [], deleted: [] };
  await navigator.locks.request(SYNC_LOCK, async () => {
    if (await readStored()) throw new VaultError("VAULT_EXISTS", "Extension đã có vault.");
    const file = await serialize(data, protection);
    const backupVersion = await uploadBackup(file, null);
    await writeStored({ file, revision: 1, backupVersion, syncedRevision: 1, lastSync: Date.now() });
    await rememberKey(protection);
  });
}

/**
 * Tự đồng bộ (chạy nền mỗi 15 phút, khi mở popup, sau khi thêm tài khoản). Không bao giờ tự
 * xoá: có tài khoản bị xoá ở máy khác thì dừng lại và báo cần xác nhận.
 */
export async function autoSync(): Promise<Attention | null> {
  const status = await standaloneStatus();
  if (status.state !== "open") return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const sync = await prepareSync();
      if (!("plan" in sync)) return null;
      if (sync.plan.pendingDeletions.length > 0) {
        return setAttention({ kind: "review", count: sync.plan.pendingDeletions.length });
      }
      await applySync(sync, []);
      return null;
    } catch (e) {
      const code = e instanceof VaultError ? e.code : "";
      if (code === "BACKUP_CHANGED" && attempt === 0) continue;
      if (code === "BACKUP_PASSWORD") return setAttention({ kind: "password" });
      if (code === "GOOGLE_SESSION_EXPIRED" || code === "GOOGLE_SIGNED_OUT") {
        return setAttention({ kind: "signin" });
      }
      // Mất mạng: lần sau thử lại, không cần báo.
      if (code === "NETWORK") return null;
      return setAttention({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }
  return null;
}

export async function attention(): Promise<Attention | null> {
  const stored = await chrome.storage.local.get(ATTENTION_KEY);
  return (stored[ATTENTION_KEY] as Attention | undefined) ?? null;
}

async function setAttention(value: Attention | null): Promise<Attention | null> {
  if (value) await chrome.storage.local.set({ [ATTENTION_KEY]: value });
  else await chrome.storage.local.remove(ATTENTION_KEY);
  await chrome.action.setBadgeText({ text: value ? "!" : "" });
  if (value) await chrome.action.setBadgeBackgroundColor({ color: "#e5484d" });
  return value;
}
