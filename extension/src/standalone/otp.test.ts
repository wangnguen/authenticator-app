import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, buildAccount, codesFor, hotp, normalizeSecret, parseUris } from "./otp";

const ascii = (s: string) => new TextEncoder().encode(s);

// Tạo protobuf MigrationPayload giống test trong migration.rs.
function varint(v: number, out: number[]) {
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}
function bytesField(field: number, data: Uint8Array, out: number[]) {
  varint((field << 3) | 2, out);
  varint(data.length, out);
  out.push(...data);
}
function varintField(field: number, v: number, out: number[]) {
  varint(field << 3, out);
  varint(v, out);
}
function params(secret: Uint8Array, name: string, issuer: string, alg: number, digits: number, kind: number) {
  const p: number[] = [];
  bytesField(1, secret, p);
  bytesField(2, ascii(name), p);
  bytesField(3, ascii(issuer), p);
  varintField(4, alg, p);
  varintField(5, digits, p);
  varintField(6, kind, p);
  return new Uint8Array(p);
}
function migrationUri(entries: Uint8Array[]): string {
  const payload: number[] = [];
  for (const entry of entries) bytesField(1, entry, payload);
  varintField(2, 1, payload);
  varintField(3, 1, payload);
  varintField(4, 0, payload);
  return `otpauth-migration://offline?data=${encodeURIComponent(btoa(String.fromCharCode(...payload)))}`;
}

describe("TOTP (RFC 6238, phụ lục B)", () => {
  const cases: [number, string, string, string][] = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];
  const sha1 = ascii("12345678901234567890");
  const sha256 = ascii("12345678901234567890123456789012");
  const sha512 = ascii("1234567890123456789012345678901234567890123456789012345678901234");

  it.each(cases)("t=%i", async (time, expected1, expected256, expected512) => {
    const counter = Math.floor(time / 30);
    expect(await hotp(sha1, counter, 8, "SHA1")).toBe(expected1);
    expect(await hotp(sha256, counter, 8, "SHA256")).toBe(expected256);
    expect(await hotp(sha512, counter, 8, "SHA512")).toBe(expected512);
  });

  it("tính mã và thời điểm hết hạn", async () => {
    const [entry] = await codesFor(
      [
        {
          id: "a",
          issuer: "GitHub",
          label: "me",
          secret: base32Encode(sha1),
          algorithm: "SHA1",
          digits: 8,
          period: 30,
          createdAt: 0,
        },
      ],
      59_000,
    );
    expect(entry.code).toBe("94287082");
    expect(entry.expiresAt).toBe(60_000);
  });
});

describe("Base32 và secret", () => {
  it("encode/decode hai chiều", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Encode(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef]))).toBe(
      "JBSWY3DPEHPK3PXP",
    );
  });

  it("chuẩn hoá giống app desktop", () => {
    expect(normalizeSecret("jbsw y3dp-ehpk 3pxp==")).toBe("JBSWY3DPEHPK3PXP");
    expect(() => normalizeSecret("   ")).toThrow("trống");
    expect(() => normalizeSecret("ABC!")).toThrow("Base32");
    expect(() => normalizeSecret("A")).toThrow("Base32");
  });

  it("kiểm tra tài khoản như app desktop", () => {
    const base = { issuer: "X", label: "", secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1" as const, digits: 6, period: 30 };
    expect(buildAccount(base, 5)).toMatchObject({ issuer: "X", createdAt: 5, updatedAt: 5 });
    expect(() => buildAccount({ ...base, issuer: " " })).toThrow("tên dịch vụ");
    expect(() => buildAccount({ ...base, digits: 9 })).toThrow("6 đến 8");
    expect(() => buildAccount({ ...base, period: 0 })).toThrow("1 đến 300");
  });
});

describe("parseUris", () => {
  it("đọc link otpauth:// đầy đủ tham số", () => {
    const { accounts } = parseUris(
      "otpauth://totp/ACME%20Co:john@example.com?secret=JBSWY3DPEHPK3PXP&issuer=ACME%20Co&algorithm=SHA256&digits=8&period=60",
    );
    expect(accounts).toEqual([
      {
        issuer: "ACME Co",
        label: "john@example.com",
        secret: "JBSWY3DPEHPK3PXP",
        algorithm: "SHA256",
        digits: 8,
        period: 60,
      },
    ]);
  });

  it("nhiều link, mỗi dòng một link", () => {
    const { accounts } = parseUris(
      "otpauth://totp/a?secret=JBSWY3DPEHPK3PXP\n  otpauth://totp/b?secret=GEZDGNBVGY3TQOJQ\n",
    );
    expect(accounts.map((a) => a.label)).toEqual(["a", "b"]);
  });

  it("từ chối HOTP, thiếu secret, link lạ", () => {
    expect(() => parseUris("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1")).toThrow("HOTP");
    expect(() => parseUris("otpauth://totp/x")).toThrow("secret");
    expect(() => parseUris("https://example.com")).toThrow("otpauth");
  });

  it("đọc link export của Google Authenticator", () => {
    const url = migrationUri([
      params(ascii("12345678901234567890"), "Example:alice@example.com", "Example", 1, 1, 2),
      params(ascii("abcdefghij"), "bob", "", 2, 2, 2),
    ]);
    const parsed = parseUris(url);
    expect(parsed.unsupported).toBe(0);
    expect(parsed.accounts).toEqual([
      {
        issuer: "Example",
        label: "alice@example.com",
        secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      },
      { issuer: "", label: "bob", secret: "MFRGGZDFMZTWQ2LK", algorithm: "SHA256", digits: 8, period: 30 },
    ]);
  });

  it("bỏ qua tài khoản HOTP và MD5 trong link migration", () => {
    const secret = ascii("12345678901234567890");
    const parsed = parseUris(
      migrationUri([
        params(secret, "hotp", "", 1, 1, 1),
        params(secret, "md5", "", 4, 1, 2),
        params(secret, "ok", "", 1, 1, 2),
      ]),
    );
    expect(parsed.accounts.map((a) => a.label)).toEqual(["ok"]);
    expect(parsed.unsupported).toBe(2);
  });

  it("từ chối dữ liệu migration hỏng", () => {
    expect(() => parseUris("otpauth-migration://offline?data=CjE")).toThrow("hỏng");
  });
});
