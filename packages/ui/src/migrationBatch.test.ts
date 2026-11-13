import { describe, expect, it } from "vitest";
import { migrationBatch, missingBatchNote, scanProgress } from "./migrationBatch";

/** Tạo link migration với một tài khoản giả và các trường lô. */
function uri(size: number, index: number, id: number): string {
  const account = [0x0a, 0x02, 0x41, 0x42]; // otp_parameters.secret = "AB"
  const bytes = [0x0a, account.length, ...account, 0x10, 1, 0x18, size, 0x20, index, 0x28, id];
  const data = btoa(String.fromCharCode(...bytes));
  return `otpauth-migration://offline?data=${encodeURIComponent(data)}`;
}

const isScanComplete = (uris: string[]) => scanProgress(uris).complete;

const GITHUB = "otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";

describe("migrationBatch", () => {
  it("đọc batch_size, batch_index, batch_id", () => {
    expect(migrationBatch(uri(3, 1, 42))).toEqual({ id: 42, index: 1, size: 3 });
  });

  it("link không có trường lô thì coi như chỉ một QR", () => {
    const data = btoa(String.fromCharCode(0x0a, 0x04, 0x0a, 0x02, 0x41, 0x42));
    expect(migrationBatch(`otpauth-migration://offline?data=${encodeURIComponent(data)}`)).toEqual({
      id: 0,
      index: 0,
      size: 1,
    });
  });

  it("bỏ qua link không phải migration hoặc dữ liệu hỏng", () => {
    expect(migrationBatch(GITHUB)).toBeNull();
    expect(migrationBatch("otpauth-migration://offline?data=%%%")).toBeNull();
    expect(migrationBatch("otpauth-migration://offline?data=CjE")).toBeNull();
  });
});

describe("scanProgress", () => {
  it("một link otpauth:// là đủ", () => {
    expect(isScanComplete([GITHUB])).toBe(true);
    expect(isScanComplete([])).toBe(false);
  });

  it("chờ đủ mọi QR của lô", () => {
    expect(isScanComplete([uri(3, 0, 7), uri(3, 2, 7)])).toBe(false);
    expect(isScanComplete([uri(3, 0, 7), uri(3, 2, 7), uri(3, 1, 7)])).toBe(true);
  });

  it("nhiều lô: lô nào cũng phải đủ", () => {
    expect(isScanComplete([uri(1, 0, 1), uri(2, 0, 2)])).toBe(false);
    expect(isScanComplete([uri(1, 0, 1), uri(2, 0, 2), uri(2, 1, 2)])).toBe(true);
  });

  it("đếm số phần đã quét của từng lô", () => {
    expect(scanProgress([uri(3, 0, 7), uri(3, 2, 7), GITHUB])).toEqual({
      complete: false,
      batches: [{ id: 7, scanned: 2, size: 3 }],
      plain: 1,
    });
  });
});

describe("missingBatchNote", () => {
  it("nhắc QR còn thiếu", () => {
    expect(missingBatchNote([uri(2, 0, 5)])).toContain("QR 1/2");
    expect(missingBatchNote([uri(2, 0, 5)])).toContain("thêm cả QR 2/2");
    expect(missingBatchNote([uri(3, 1, 5)])).toContain("thêm cả QR 1/3, 3/3");
  });

  it("đủ QR, chỉ một QR, hoặc link thường thì không nhắc", () => {
    expect(missingBatchNote([uri(2, 0, 5), uri(2, 1, 5)])).toBeNull();
    expect(missingBatchNote([uri(1, 0, 5)])).toBeNull();
    expect(missingBatchNote([GITHUB])).toBeNull();
  });
});
