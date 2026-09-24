import QRCode from "qrcode";
import { describe, expect, it } from "vitest";
import { findQrCodes, type RgbaImage } from "./qrScan";

const SCALE = 4;
const QUIET = 4;

interface Placement {
  text: string;
  x: number;
  y: number;
}

/** Vẽ các QR lên nền trắng kích thước width×height. */
function render(width: number, height: number, codes: Placement[]): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const { text, x, y } of codes) {
    const modules = QRCode.create(text, { errorCorrectionLevel: "M" }).modules;
    for (let row = 0; row < modules.size; row++) {
      for (let col = 0; col < modules.size; col++) {
        if (!modules.get(row, col)) continue;
        for (let dy = 0; dy < SCALE; dy++) {
          for (let dx = 0; dx < SCALE; dx++) {
            const px = x + (col + QUIET) * SCALE + dx;
            const py = y + (row + QUIET) * SCALE + dy;
            const i = (py * width + px) * 4;
            data[i] = data[i + 1] = data[i + 2] = 0;
          }
        }
      }
    }
  }
  return { data, width, height };
}

const GITHUB = "otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";
const GITLAB = "otpauth://totp/GitLab:bob?secret=GEZDGNBVGY3TQOJQ&issuer=GitLab";
const MIGRATION = "otpauth-migration://offline?data=CjEKCkhlbGxvId6tvu8SGEV4YW1wbGU6YWxpY2VAZXhhbXBsZS5jb20aB0V4YW1wbGUgASgBMAIQARgBIAA%3D";
const WEBSITE = "https://example.com/not-a-2fa-code";

describe("findQrCodes", () => {
  it("đọc ảnh chỉ có một QR", () => {
    expect(findQrCodes(render(300, 300, [{ text: GITHUB, x: 20, y: 20 }]))).toEqual([GITHUB]);
  });

  it("nhận ImageData thật (width/height là getter trên prototype)", () => {
    const { data, width, height } = render(300, 300, [{ text: GITHUB, x: 20, y: 20 }]);
    class FakeImageData {
      get data() {
        return data;
      }
      get width() {
        return width;
      }
      get height() {
        return height;
      }
    }
    expect(findQrCodes(new FakeImageData())).toEqual([GITHUB]);
  });

  it("trả về mảng rỗng khi không có QR", () => {
    expect(findQrCodes(render(200, 200, []))).toEqual([]);
  });

  it("đọc nhiều QR nằm ngang trong một ảnh", () => {
    const image = render(1100, 360, [
      { text: GITHUB, x: 30, y: 40 },
      { text: GITLAB, x: 400, y: 40 },
      { text: WEBSITE, x: 770, y: 40 },
    ]);
    expect(findQrCodes(image).sort()).toEqual([GITHUB, GITLAB, WEBSITE].sort());
  });

  it("đọc lưới 2×2 QR", () => {
    const image = render(760, 760, [
      { text: GITHUB, x: 20, y: 20 },
      { text: GITLAB, x: 400, y: 20 },
      { text: MIGRATION, x: 20, y: 400 },
      { text: WEBSITE, x: 400, y: 400 },
    ]);
    expect(findQrCodes(image).sort()).toEqual([GITHUB, GITLAB, MIGRATION, WEBSITE].sort());
  });

  it("đọc QR nhỏ trong ảnh chụp màn hình lớn", () => {
    const image = render(1600, 900, [{ text: GITHUB, x: 1250, y: 600 }]);
    expect(findQrCodes(image)).toEqual([GITHUB]);
  });
});
