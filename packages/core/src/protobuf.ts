/**
 * Đọc protobuf ở mức wire format, đủ cho link `otpauth-migration://` của Google Authenticator
 * (xem desktop/src-tauri/src/migration.rs). Bỏ qua field 32/64-bit.
 */
export interface ProtoField {
  field: number;
  /** Có khi field là varint (chỉ chính xác tới 2^53). */
  varint?: number;
  /** Có khi field là length-delimited (bytes, string, message con). */
  bytes?: Uint8Array;
}

/** `null` nếu dữ liệu hỏng (cắt cụt, độ dài sai, wire type lạ). */
export function readProtoFields(buf: Uint8Array): ProtoField[] | null {
  const fields: ProtoField[] = [];
  let pos = 0;
  const varint = (): number | null => {
    let result = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      if (pos >= buf.length) return null;
      const byte = buf[pos++];
      if (shift < 53) result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
    }
    return null;
  };
  while (pos < buf.length) {
    const key = varint();
    if (key === null) return null;
    const field = Math.floor(key / 8);
    switch (key % 8) {
      case 0: {
        const value = varint();
        if (value === null) return null;
        fields.push({ field, varint: value });
        break;
      }
      case 1:
        pos += 8;
        break;
      case 2: {
        const length = varint();
        if (length === null || pos + length > buf.length) return null;
        fields.push({ field, bytes: buf.subarray(pos, pos + length) });
        pos += length;
        break;
      }
      case 5:
        pos += 4;
        break;
      default:
        return null;
    }
    if (pos > buf.length) return null;
  }
  return fields;
}

/**
 * Base64 trong tham số `data` của link migration: chấp nhận cả base64url, có hoặc không padding,
 * và dấu cách (query string đổi "+" thành dấu cách). `null` nếu không hợp lệ.
 */
export function decodeLooseBase64(data: string): Uint8Array | null {
  const standard = data
    .trim()
    .replace(/=+$/, "")
    .replace(/ /g, "+")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  try {
    const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
