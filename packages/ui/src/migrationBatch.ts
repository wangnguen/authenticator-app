/**
 * Google Authenticator chia bản export nhiều tài khoản thành nhiều QR (1/3, 2/3...). Mỗi QR là
 * `otpauth-migration://offline?data=<base64 protobuf>` có các trường:
 * `batch_size = 3; batch_index = 4; batch_id = 5` (int32, varint). Đọc chúng để biết đã quét đủ chưa.
 */
export interface MigrationBatch {
  id: number;
  /** Bắt đầu từ 0. */
  index: number;
  size: number;
}

/** Thông tin lô của link migration; `null` nếu không phải link migration hoặc dữ liệu hỏng. */
export function migrationBatch(uri: string): MigrationBatch | null {
  const match = /^otpauth-migration:\/\/offline\?(.*)$/i.exec(uri.trim());
  if (!match) return null;
  const data = new URLSearchParams(match[1]).get("data");
  if (!data) return null;
  const bytes = decodeBase64(data);
  if (!bytes) return null;

  const batch: MigrationBatch = { id: 0, index: 0, size: 1 };
  let pos = 0;
  const varint = (): number | null => {
    let result = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      if (pos >= bytes.length) return null;
      const byte = bytes[pos++];
      // Chỉ cần 32 bit thấp (int32); các byte cao hơn chỉ đọc qua.
      if (shift < 32) result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
    }
    return null;
  };

  while (pos < bytes.length) {
    const key = varint();
    if (key === null) return null;
    const field = Math.floor(key / 8);
    switch (key % 8) {
      case 0: {
        const value = varint();
        if (value === null) return null;
        if (field === 3) batch.size = value;
        else if (field === 4) batch.index = value;
        else if (field === 5) batch.id = value;
        break;
      }
      case 1:
        pos += 8;
        break;
      case 2: {
        const length = varint();
        if (length === null) return null;
        pos += length;
        break;
      }
      case 5:
        pos += 4;
        break;
      default:
        return null;
    }
  }
  if (pos !== bytes.length || batch.size < 1 || batch.index >= batch.size) return null;
  return batch;
}

export interface ScanProgress {
  /** Đã đủ mọi QR chưa: lô migration nào cũng đủ `size` phần, link `otpauth://` thì một mã là đủ. */
  complete: boolean;
  /** Mỗi lô migration: đã quét bao nhiêu phần trên tổng số. */
  batches: { id: number; scanned: number; size: number }[];
  /** Số link `otpauth://` thường (không phải migration). */
  plain: number;
}

export function scanProgress(uris: string[]): ScanProgress {
  const seen = new Map<number, { size: number; indexes: Set<number> }>();
  let plain = 0;
  for (const uri of uris) {
    const batch = migrationBatch(uri);
    if (!batch) {
      plain++;
      continue;
    }
    const entry = seen.get(batch.id) ?? { size: batch.size, indexes: new Set<number>() };
    entry.indexes.add(batch.index);
    seen.set(batch.id, entry);
  }
  const batches = [...seen].map(([id, b]) => ({ id, scanned: b.indexes.size, size: b.size }));
  return {
    complete: uris.length > 0 && batches.every((b) => b.scanned >= b.size),
    batches,
    plain,
  };
}

function decodeBase64(data: string): Uint8Array | null {
  // URLSearchParams đổi "+" thành dấu cách; link cũng có thể dùng base64url.
  const normalized = data.trim().replace(/ /g, "+").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
