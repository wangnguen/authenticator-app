import { findQrCodes } from "./qrScan";

/** Đọc mọi QR code trong một ảnh (data URL / blob URL). */
export async function decodeQrCodesFromImage(src: string): Promise<string[]> {
  const img = new Image();
  img.src = src;
  await img.decode();

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];
  ctx.drawImage(img, 0, 0);
  return findQrCodes(ctx.getImageData(0, 0, canvas.width, canvas.height));
}

export async function decodeQrCodesFromFile(file: Blob): Promise<string[]> {
  const url = URL.createObjectURL(file);
  try {
    return await decodeQrCodesFromImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function isOtpUri(text: string): boolean {
  return /^otpauth(-migration)?:\/\//i.test(text.trim());
}

export interface QrScanResult {
  /** Link otpauth:// hoặc otpauth-migration:// đọc được. */
  uris: string[];
  /** Số ảnh không có QR nào. */
  imagesWithoutQr: number;
  /** Số QR không phải link OTP (ví dụ QR của một trang web). */
  otherQr: number;
}

/** Quét nhiều ảnh, gom các link OTP (bỏ trùng). */
export async function scanOtpQrImages(files: Blob[]): Promise<QrScanResult> {
  const result: QrScanResult = { uris: [], imagesWithoutQr: 0, otherQr: 0 };
  for (const file of files) {
    const codes = await decodeQrCodesFromFile(file);
    if (codes.length === 0) result.imagesWithoutQr++;
    for (const code of codes) {
      if (!isOtpUri(code)) result.otherQr++;
      else if (!result.uris.includes(code)) result.uris.push(code);
    }
  }
  return result;
}
