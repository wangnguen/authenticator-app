import jsQR from "jsqr";

/** Đọc QR code từ một ảnh (data URL / blob URL). Trả về null nếu không thấy. */
export async function decodeQrFromImage(src: string): Promise<string | null> {
  const img = new Image();
  img.src = src;
  await img.decode();

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);

  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(data, width, height, { inversionAttempts: "attemptBoth" })?.data ?? null;
}

export async function decodeQrFromFile(file: Blob): Promise<string | null> {
  const url = URL.createObjectURL(file);
  try {
    return await decodeQrFromImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
