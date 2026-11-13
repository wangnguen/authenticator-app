import { describe, expect, it } from "vitest";
import { migrationBatch, scanProgress } from "./migrationBatch";

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

  it("đọc link export thật của Google Authenticator", () => {
    const real =
      "otpauth-migration://offline?data=CjEKCkhlbGxvId6tvu8SGEV4YW1wbGU6YWxpY2VAZXhhbXBsZS5jb20aB0V4YW1wbGUgASgBMAIQARgBIAA%3D";
    expect(migrationBatch(real)).toEqual({ id: 0, index: 0, size: 1 });
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
