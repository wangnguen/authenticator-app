import { decodeLooseBase64, readProtoFields } from "@auth/core";

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
  const bytes = decodeLooseBase64(data);
  const fields = bytes && readProtoFields(bytes);
  if (!fields) return null;

  const batch: MigrationBatch = { id: 0, index: 0, size: 1 };
  for (const { field, varint } of fields) {
    if (varint === undefined) continue;
    if (field === 3) batch.size = varint;
    else if (field === 4) batch.index = varint;
    else if (field === 5) batch.id = varint;
  }
  if (batch.size < 1 || batch.index >= batch.size) return null;
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

/**
 * Nhắc thêm các QR còn thiếu khi import ảnh: Google Authenticator chia bản xuất thành nhiều QR,
 * mỗi QR tối đa 10 tài khoản. `null` nếu đủ (hoặc không phải link xuất của Google Authenticator).
 * Ví dụ: "ảnh có QR 1/2 của Google Authenticator (mỗi QR tối đa 10 tài khoản), nhớ thêm cả QR 2/2".
 */
export function missingBatchNote(uris: string[]): string | null {
  const seen = new Map<number, { size: number; indexes: Set<number> }>();
  for (const uri of uris) {
    const batch = migrationBatch(uri);
    if (!batch || batch.size <= 1) continue;
    const entry = seen.get(batch.id) ?? { size: batch.size, indexes: new Set<number>() };
    entry.indexes.add(batch.index);
    seen.set(batch.id, entry);
  }
  for (const { size, indexes } of seen.values()) {
    if (indexes.size >= size) continue;
    const label = (i: number) => `${i + 1}/${size}`;
    const have = [...indexes].sort((a, b) => a - b).map(label);
    const missing = Array.from({ length: size }, (_, i) => i).filter((i) => !indexes.has(i)).map(label);
    return (
      `ảnh có QR ${have.join(", ")} của Google Authenticator (mỗi QR tối đa 10 tài khoản), ` +
      `nhớ thêm cả QR ${missing.join(", ")}: bấm "Tiếp" trên điện thoại`
    );
  }
  return null;
}
