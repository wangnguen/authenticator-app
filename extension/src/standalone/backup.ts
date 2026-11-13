import { argon2id } from "hash-wasm";
import { type Account, type Deleted, type StoredGroup, type VaultData, VaultError } from "./types";

/**
 * Định dạng bản sao lưu trên Drive, giống hệt vault.rs của app desktop:
 * - vault có master password: `VaultFile` = Argon2id(password, salt) → AES-256-GCM, AAD
 *   "authenticator-vault-v1".
 * - vault không mật khẩu: JSON không mã hoá `{format: "authenticator-plain-backup", ...}`.
 */

const AAD = new TextEncoder().encode("authenticator-vault-v1");
/** v3: thêm group (xem FILE_VERSION trong vault.rs). */
const FILE_VERSION = 3;
const MIN_FILE_VERSION = 1;
const PLAIN_FORMAT = "authenticator-plain-backup";
const PLAIN_VERSION = 2;
export const MIN_PASSWORD_LEN = 8;

export interface KdfParams {
  salt: string;
  memoryKib: number;
  iterations: number;
  parallelism: number;
}

interface VaultFile {
  version: number;
  kdf?: KdfParams;
  deviceKey?: string;
  nonce: string;
  ciphertext: string;
}

export type Backup =
  | { kind: "plain"; data: VaultData }
  | { kind: "encrypted"; file: VaultFile & { kdf: KdfParams } };

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** Tham số giống KdfParams::generate() (khuyến nghị OWASP). */
export function generateKdf(): KdfParams {
  return {
    salt: toBase64(crypto.getRandomValues(new Uint8Array(16))),
    memoryKib: 19 * 1024,
    iterations: 2,
    parallelism: 1,
  };
}

export function sameKdf(a: KdfParams, b: KdfParams): boolean {
  return (
    a.salt === b.salt &&
    a.memoryKib === b.memoryKib &&
    a.iterations === b.iterations &&
    a.parallelism === b.parallelism
  );
}

/** Key 32 byte từ master password (mất khoảng nửa giây). */
export async function deriveKey(password: string, kdf: KdfParams): Promise<Uint8Array> {
  return argon2id({
    password,
    salt: fromBase64(kdf.salt),
    parallelism: kdf.parallelism,
    iterations: kdf.iterations,
    memorySize: kdf.memoryKib,
    hashLength: 32,
    outputType: "binary",
  });
}

function aesKey(key: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

const invalidBackup = (message = "Bản sao lưu không hợp lệ.") =>
  new VaultError("INVALID_BACKUP", message);
const newerBackup = () =>
  invalidBackup("Bản sao lưu được tạo bởi phiên bản app mới hơn. Hãy cập nhật extension.");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Kiểm tra dữ liệu giải mã/đọc được có đúng dạng không (vault v1 là mảng tài khoản). */
function toVaultData(value: unknown): VaultData {
  const isAccount = (a: unknown): a is Account =>
    isRecord(a) &&
    typeof a.id === "string" &&
    typeof a.secret === "string" &&
    typeof a.issuer === "string" &&
    typeof a.label === "string" &&
    typeof a.digits === "number" &&
    typeof a.period === "number" &&
    typeof a.createdAt === "number" &&
    ["SHA1", "SHA256", "SHA512"].includes(a.algorithm as string) &&
    (a.groupIds === undefined ||
      (Array.isArray(a.groupIds) && a.groupIds.every((id) => typeof id === "string")));
  const isGroup = (g: unknown): g is StoredGroup =>
    isRecord(g) &&
    typeof g.id === "string" &&
    typeof g.name === "string" &&
    typeof g.updatedAt === "number" &&
    (g.hidden === undefined || typeof g.hidden === "boolean") &&
    (g.deletedAt === undefined || g.deletedAt === null || typeof g.deletedAt === "number");
  const isDeleted = (d: unknown): d is Deleted =>
    isRecord(d) &&
    typeof d.id === "string" &&
    typeof d.deletedAt === "number" &&
    (d.account === undefined || d.account === null || isAccount(d.account));

  const raw = Array.isArray(value) ? { accounts: value, deleted: [] } : value;
  if (!isRecord(raw) || !Array.isArray(raw.accounts)) throw invalidBackup();
  const deleted = raw.deleted ?? [];
  const groups = raw.groups ?? [];
  if (
    !Array.isArray(deleted) ||
    !Array.isArray(groups) ||
    !raw.accounts.every(isAccount) ||
    !deleted.every(isDeleted) ||
    !groups.every(isGroup)
  ) {
    throw invalidBackup();
  }
  return {
    accounts: raw.accounts,
    deleted: deleted.map((d) => (d.account ? d : { id: d.id, deletedAt: d.deletedAt })),
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      hidden: g.hidden ?? false,
      updatedAt: g.updatedAt,
      ...(typeof g.deletedAt === "number" ? { deletedAt: g.deletedAt } : {}),
    })),
  };
}

export function parseBackup(text: string): Backup {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalidBackup();
  }
  if (!isRecord(value)) throw invalidBackup();
  if (value.format === PLAIN_FORMAT) {
    if (typeof value.version === "number" && value.version > PLAIN_VERSION) throw newerBackup();
    return { kind: "plain", data: toVaultData(value) };
  }

  const { version, kdf, nonce, ciphertext } = value;
  if (
    typeof version !== "number" ||
    typeof nonce !== "string" ||
    typeof ciphertext !== "string" ||
    !isRecord(kdf) ||
    typeof kdf.salt !== "string" ||
    typeof kdf.memoryKib !== "number" ||
    typeof kdf.iterations !== "number" ||
    typeof kdf.parallelism !== "number"
  ) {
    throw invalidBackup();
  }
  if (version < MIN_FILE_VERSION || version > FILE_VERSION) throw newerBackup();
  return {
    kind: "encrypted",
    file: { version, nonce, ciphertext, kdf: kdf as unknown as KdfParams },
  };
}

/** Giải mã; sai key thì lỗi `WRONG_PASSWORD`. */
export async function openFile(file: VaultFile, key: Uint8Array): Promise<VaultData> {
  const nonce = fromBase64(file.nonce);
  if (nonce.length !== 12) throw invalidBackup("Nonce không hợp lệ.");
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: AAD },
      await aesKey(key),
      fromBase64(file.ciphertext) as BufferSource,
    );
  } catch {
    throw new VaultError("WRONG_PASSWORD", "Sai master password.");
  }
  return toVaultData(JSON.parse(new TextDecoder().decode(plaintext)));
}

/** Nội dung file theo đúng thứ tự trường mà serde của app ghi ra. */
function serializeData(data: VaultData): string {
  const account = (a: Account) => ({
    id: a.id,
    issuer: a.issuer,
    label: a.label,
    secret: a.secret,
    algorithm: a.algorithm,
    digits: a.digits,
    period: a.period,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt ?? 0,
    ...(a.groupIds?.length ? { groupIds: a.groupIds } : {}),
  });
  return JSON.stringify({
    accounts: data.accounts.map(account),
    deleted: data.deleted.map((d) =>
      d.account
        ? { id: d.id, deletedAt: d.deletedAt, account: account(d.account) }
        : { id: d.id, deletedAt: d.deletedAt },
    ),
    groups: data.groups.map((g) => ({
      id: g.id,
      name: g.name,
      hidden: g.hidden,
      updatedAt: g.updatedAt,
      ...(g.deletedAt !== undefined ? { deletedAt: g.deletedAt } : {}),
    })),
  });
}

export async function sealFile(
  data: VaultData,
  key: Uint8Array,
  kdf: KdfParams,
): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: AAD },
    await aesKey(key),
    new TextEncoder().encode(serializeData(data)),
  );
  const file: VaultFile = {
    version: FILE_VERSION,
    kdf,
    nonce: toBase64(nonce),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
  return JSON.stringify(file, null, 2);
}

export function plainFile(data: VaultData): string {
  const parsed = JSON.parse(serializeData(data)) as object;
  return JSON.stringify({ format: PLAIN_FORMAT, version: PLAIN_VERSION, ...parsed }, null, 2);
}

/** So sánh hai bộ dữ liệu, bỏ qua thứ tự (để biết có cần tải lên Drive không). */
export function sameData(a: VaultData, b: VaultData): boolean {
  const sorted = (data: VaultData): VaultData => ({
    accounts: [...data.accounts].sort((x, y) => compareId(x.id, y.id)),
    deleted: [...data.deleted].sort((x, y) => compareId(x.id, y.id)),
    groups: [...data.groups].sort((x, y) => compareId(x.id, y.id)),
  });
  return serializeData(sorted(a)) === serializeData(sorted(b));
}

/** So sánh theo byte như `String::cmp` của Rust (id là UUID ASCII). */
export function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
