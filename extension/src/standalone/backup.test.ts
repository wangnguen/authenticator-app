import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  deriveKey,
  generateKdf,
  openFile,
  parseBackup,
  plainFile,
  sameData,
  sealFile,
} from "./backup";
import type { VaultData } from "./types";

/**
 * Bản sao lưu do app desktop (Rust) tạo: master password "correct horse", có GitHub (SHA1) và
 * Bank (SHA256, 8 số, 60s) đã chuyển vào Thùng rác. Xem test `opens_backup_sealed_by_extension`
 * trong vault.rs cho chiều ngược lại.
 */
const RUST_BACKUP = readFileSync(new URL("./fixtures/rust-backup.json", import.meta.url), "utf8");

describe("bản sao lưu dùng chung với app desktop", () => {
  it("giải mã bản sao lưu do app desktop tạo", async () => {
    const backup = parseBackup(RUST_BACKUP);
    if (backup.kind !== "encrypted") throw new Error("phải là bản mã hoá");
    const data = await openFile(backup.file, await deriveKey("correct horse", backup.file.kdf));
    expect(data.accounts.map((a) => [a.issuer, a.label, a.secret])).toEqual([
      ["GitHub", "alice", "JBSWY3DPEHPK3PXP"],
    ]);
    expect(data.deleted).toHaveLength(1);
    expect(data.deleted[0].account).toMatchObject({
      issuer: "Bank",
      algorithm: "SHA256",
      digits: 8,
      period: 60,
    });
  });

  it("sai master password", async () => {
    const backup = parseBackup(RUST_BACKUP);
    if (backup.kind !== "encrypted") throw new Error("phải là bản mã hoá");
    await expect(
      openFile(backup.file, await deriveKey("wrong password", backup.file.kdf)),
    ).rejects.toMatchObject({ code: "WRONG_PASSWORD" });
  });

  it("mã hoá rồi giải mã lại được, giữ nguyên dữ liệu", async () => {
    const backup = parseBackup(RUST_BACKUP);
    if (backup.kind !== "encrypted") throw new Error("phải là bản mã hoá");
    const key = await deriveKey("correct horse", backup.file.kdf);
    const data = await openFile(backup.file, key);
    const resealed = parseBackup(await sealFile(data, key, backup.file.kdf));
    if (resealed.kind !== "encrypted") throw new Error("phải là bản mã hoá");
    expect(resealed.file.kdf).toEqual(backup.file.kdf);
    expect(sameData(await openFile(resealed.file, key), data)).toBe(true);
  });

  it("bản không mật khẩu", () => {
    const data: VaultData = {
      accounts: [
        {
          id: "a",
          issuer: "X",
          label: "y",
          secret: "JBSWY3DPEHPK3PXP",
          algorithm: "SHA1",
          digits: 6,
          period: 30,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      deleted: [{ id: "b", deletedAt: 2 }],
    };
    const text = plainFile(data);
    expect(JSON.parse(text)).toMatchObject({ format: "authenticator-plain-backup", version: 1 });
    const backup = parseBackup(text);
    expect(backup.kind === "plain" && sameData(backup.data, data)).toBe(true);
  });

  it("từ chối file lạ hoặc của phiên bản mới hơn", () => {
    expect(() => parseBackup("not json")).toThrow("không hợp lệ");
    expect(() => parseBackup('{"accounts": 1}')).toThrow("không hợp lệ");
    const future = { ...JSON.parse(RUST_BACKUP), version: 99 };
    expect(() => parseBackup(JSON.stringify(future))).toThrow("mới hơn");
  });

  it("tham số Argon2id giống app desktop", () => {
    expect(generateKdf()).toMatchObject({ memoryKib: 19456, iterations: 2, parallelism: 1 });
  });
});
