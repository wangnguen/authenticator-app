import {
  type Algorithm,
  type CodeEntry,
  decodeLooseBase64,
  type NewAccount,
  readProtoFields,
} from "@auth/core";
import { type Account, type ParsedAccounts, VaultError } from "./types";

/**
 * TOTP (RFC 6238), chuẩn hoá secret và đọc link otpauth:// / otpauth-migration://.
 * Chép từ totp.rs, vault.rs (build_account) và otpauth.rs / migration.rs của app desktop:
 * kết quả phải giống hệt để hai bên nhận ra cùng một tài khoản (so sánh theo secret).
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32 không padding; bỏ qua bit thừa cuối chuỗi như app desktop. `null` nếu không hợp lệ. */
export function base32Decode(input: string): Uint8Array | null {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of input) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value < 0) return null;
    buffer = ((buffer << 5) | value) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  // Độ dài hợp lệ của base32 không padding: số ký tự dư (mod 8) không thể là 1, 3, 6.
  if ([1, 3, 6].includes(input.length % 8)) return null;
  return new Uint8Array(out);
}

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

const HASH: Record<Algorithm, string> = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" };

export async function hotp(
  secret: Uint8Array,
  counter: number,
  digits: number,
  algorithm: Algorithm,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secret as BufferSource,
    { name: "HMAC", hash: HASH[algorithm] },
    false,
    ["sign"],
  );
  const message = new DataView(new ArrayBuffer(8));
  message.setUint32(0, Math.floor(counter / 2 ** 32));
  message.setUint32(4, counter >>> 0);
  const hash = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = hash[hash.length - 1] & 0x0f;
  const binary =
    ((hash[offset] & 0x7f) << 24) |
    (hash[offset + 1] << 16) |
    (hash[offset + 2] << 8) |
    hash[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** Mã hiện tại của mọi tài khoản, sắp xếp giống app desktop. */
export async function codesFor(accounts: Account[], now = Date.now()): Promise<CodeEntry[]> {
  const entries = await Promise.all(
    accounts.map(async (account) => {
      const counter = Math.floor(now / 1000 / account.period);
      const secret = base32Decode(account.secret) ?? new Uint8Array();
      return {
        id: account.id,
        issuer: account.issuer,
        label: account.label,
        code: await hotp(secret, counter, account.digits, account.algorithm),
        digits: account.digits,
        period: account.period,
        expiresAt: (counter + 1) * account.period * 1000,
      };
    }),
  );
  const key = (e: CodeEntry) => [e.issuer.toLowerCase(), e.label.toLowerCase()];
  return entries.sort((a, b) => {
    const [ai, al] = key(a);
    const [bi, bl] = key(b);
    return ai < bi ? -1 : ai > bi ? 1 : al < bl ? -1 : al > bl ? 1 : 0;
  });
}

export function normalizeSecret(secret: string): string {
  const normalized = secret.replace(/[\s=-]/g, "").toUpperCase();
  if (!normalized) throw new VaultError("INVALID_ACCOUNT", "Secret không được để trống.");
  if (!base32Decode(normalized)) {
    throw new VaultError("INVALID_ACCOUNT", "Secret phải là chuỗi Base32 hợp lệ.");
  }
  return normalized;
}

/** Tài khoản mới từ dữ liệu nhập, cùng quy tắc kiểm tra với app desktop. */
export function buildAccount(input: NewAccount, now = Date.now()): Account {
  const secret = normalizeSecret(input.secret);
  const issuer = input.issuer.trim();
  const label = input.label.trim();
  if (!issuer && !label) {
    throw new VaultError("INVALID_ACCOUNT", "Cần nhập tên dịch vụ hoặc tài khoản.");
  }
  if (!(input.digits >= 6 && input.digits <= 8)) {
    throw new VaultError("INVALID_ACCOUNT", "Số chữ số phải từ 6 đến 8.");
  }
  if (!(input.period >= 1 && input.period <= 300)) {
    throw new VaultError("INVALID_ACCOUNT", "Chu kỳ phải từ 1 đến 300 giây.");
  }
  return {
    id: crypto.randomUUID(),
    issuer,
    label,
    secret,
    algorithm: input.algorithm,
    digits: input.digits,
    period: input.period,
    createdAt: now,
    updatedAt: now,
  };
}

const invalidUri = (message: string) => new VaultError("INVALID_URI", message);

/** Một hoặc nhiều link (cách nhau bởi khoảng trắng/xuống dòng). */
export function parseUris(input: string): ParsedAccounts {
  const parsed: ParsedAccounts = { accounts: [], unsupported: 0 };
  for (const uri of input.split(/\s+/).filter(Boolean)) {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      throw invalidUri("Link không hợp lệ.");
    }
    if (url.protocol === "otpauth:") parsed.accounts.push(parseOtpauth(url));
    else if (url.protocol === "otpauth-migration:") {
      const batch = parseMigration(url);
      parsed.accounts.push(...batch.accounts);
      parsed.unsupported += batch.unsupported;
    } else {
      throw invalidUri("Link phải bắt đầu bằng otpauth:// hoặc otpauth-migration://");
    }
  }
  if (parsed.accounts.length === 0 && parsed.unsupported === 0) throw invalidUri("Chưa nhập link.");
  return parsed;
}

const ALGORITHMS: Algorithm[] = ["SHA1", "SHA256", "SHA512"];

function parseOtpauth(url: URL): NewAccount {
  // Với scheme lạ, trình duyệt để "//totp/..." trong pathname thay vì tách host.
  const match = /^\/\/([^/?#]*)\/?(.*)$/.exec(url.pathname);
  const host = (url.host || match?.[1] || "").toLowerCase();
  const rawPath = url.host ? url.pathname.replace(/^\//, "") : (match?.[2] ?? "");
  if (host === "hotp") throw invalidUri("Chưa hỗ trợ HOTP.");
  if (host !== "totp") throw invalidUri("Loại OTP không hợp lệ.");

  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    path = rawPath;
  }
  const colon = path.indexOf(":");
  const account: NewAccount = {
    issuer: colon >= 0 ? path.slice(0, colon).trim() : "",
    label: (colon >= 0 ? path.slice(colon + 1) : path).trim(),
    secret: "",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  };
  for (const [key, value] of url.searchParams) {
    switch (key) {
      case "secret":
        account.secret = value;
        break;
      case "issuer":
        if (value.trim()) account.issuer = value.trim();
        break;
      case "algorithm": {
        const algorithm = ALGORITHMS.find((a) => a === value.toUpperCase());
        if (!algorithm) throw invalidUri("Thuật toán không hỗ trợ.");
        account.algorithm = algorithm;
        break;
      }
      case "digits":
        account.digits = parseNumber(value, "Số chữ số không hợp lệ.");
        break;
      case "period":
        account.period = parseNumber(value, "Chu kỳ không hợp lệ.");
        break;
    }
  }
  if (!account.secret) throw invalidUri("Link thiếu secret.");
  return account;
}

function parseNumber(value: string, message: string): number {
  if (!/^\d+$/.test(value)) throw invalidUri(message);
  return Number(value);
}

// ---- otpauth-migration:// (protobuf MigrationPayload, xem migration.rs) ----

function parseMigration(url: URL): ParsedAccounts {
  // Với scheme lạ, URL vẫn tách được query string.
  const data = url.searchParams.get("data");
  if (!data) throw invalidUri("Link migration thiếu tham số data.");
  const bytes = decodeLooseBase64(data);
  if (!bytes) throw invalidUri("Dữ liệu migration không phải base64 hợp lệ.");
  const fields = readProtoFields(bytes);
  if (!fields) throw invalidUri("Dữ liệu migration bị hỏng.");

  const result: ParsedAccounts = { accounts: [], unsupported: 0 };
  for (const { field, bytes: params } of fields) {
    if (field !== 1 || !params) continue;
    const account = decodeParams(params);
    if (account === undefined) throw invalidUri("Dữ liệu migration bị hỏng.");
    if (account) result.accounts.push(account);
    else result.unsupported++;
  }
  return result;
}

/** `null`: loại/thuật toán chưa hỗ trợ; `undefined`: dữ liệu hỏng. */
function decodeParams(bytes: Uint8Array): NewAccount | null | undefined {
  const fields = readProtoFields(bytes);
  if (!fields) return undefined;
  const text = (b?: Uint8Array) => (b ? new TextDecoder().decode(b) : "");
  let secret: Uint8Array = new Uint8Array();
  let name = "";
  let issuer = "";
  let algorithm = 0;
  let digits = 0;
  let otpType = 0;
  for (const f of fields) {
    if (f.field === 1 && f.bytes) secret = f.bytes;
    else if (f.field === 2 && f.bytes) name = text(f.bytes);
    else if (f.field === 3 && f.bytes) issuer = text(f.bytes);
    else if (f.field === 4 && f.varint !== undefined) algorithm = f.varint;
    else if (f.field === 5 && f.varint !== undefined) digits = f.varint;
    else if (f.field === 6 && f.varint !== undefined) otpType = f.varint;
  }
  const alg: Algorithm | null =
    algorithm === 0 || algorithm === 1
      ? "SHA1"
      : algorithm === 2
        ? "SHA256"
        : algorithm === 3
          ? "SHA512"
          : null;
  if (!alg || otpType === 1) return null;

  // name thường có dạng "Issuer:label" hoặc chỉ "label".
  name = name.trim();
  let label = name;
  const colon = name.indexOf(":");
  if (colon >= 0) {
    const prefix = name.slice(0, colon).trim();
    if (!issuer || prefix === issuer.trim()) {
      if (!issuer) issuer = prefix;
      label = name.slice(colon + 1).trim();
    }
  }
  return {
    issuer: issuer.trim(),
    label,
    secret: base32Encode(secret),
    algorithm: alg,
    digits: digits === 2 ? 8 : 6,
    period: 30,
  };
}
