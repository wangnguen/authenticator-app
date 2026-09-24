import jsQR from "jsqr";

export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const MAX_CODES = 20;
/** Kích thước ô quét = cạnh ngắn của ảnh / n, để tách từng QR khi ảnh có nhiều mã. */
const GRID_DIVISIONS = [1, 2, 3, 4];
const MIN_WINDOW = 60;

/**
 * Tìm mọi QR code trong ảnh RGBA.
 * jsQR chỉ đọc một mã mỗi lần và dễ lẫn ô định vị giữa các mã khi ảnh có nhiều QR,
 * nên quét cả ảnh trước rồi quét từng vùng nhỏ chồng lên nhau. Mã đã đọc được tô
 * trắng để không bị đọc lại và không làm nhiễu các vùng sau.
 */
export function findQrCodes(image: RgbaImage): string[] {
  // Không dùng {...image}: width/height của ImageData là getter trên prototype nên spread bị mất.
  const img: RgbaImage = {
    data: new Uint8ClampedArray(image.data),
    width: image.width,
    height: image.height,
  };
  const found: string[] = [];

  /** true nếu tìm thấy mã mới trong vùng (x, y, w, h). */
  const scan = (x: number, y: number, w: number, h: number): boolean => {
    const region = crop(img, x, y, w, h);
    // Chỉ thử QR đảo màu (sáng trên nền tối) khi quét cả ảnh: quét lưới có rất nhiều ô
    // không chứa QR, thử cả hai kiểu sẽ chậm gấp đôi.
    const whole = w === img.width && h === img.height;
    const code = jsQR(region.data, w, h, {
      inversionAttempts: whole ? "attemptBoth" : "dontInvert",
    });
    if (!code) return false;
    mask(img, code.location, x, y);
    if (found.includes(code.data)) return false;
    found.push(code.data);
    return true;
  };

  while (found.length < MAX_CODES && scan(0, 0, img.width, img.height));

  // Ô vuông cạnh = cạnh ngắn / n, trượt nửa ô một lần: QR nhỏ hơn nửa ô chắc chắn
  // nằm trọn trong ít nhất một ô, kể cả với ảnh rất dài hoặc rất rộng.
  for (const n of GRID_DIVISIONS) {
    const side = Math.floor(Math.min(img.width, img.height) / n);
    if (side < MIN_WINDOW) break;
    for (const y of positions(img.height, side)) {
      for (const x of positions(img.width, side)) {
        while (found.length < MAX_CODES && scan(x, y, side, side));
      }
    }
  }
  return found;
}

/** Vị trí bắt đầu các ô cạnh `size` phủ hết chiều dài `total`, chồng nhau một nửa. */
function positions(total: number, size: number): number[] {
  const step = Math.max(1, Math.floor(size / 2));
  const result: number[] = [];
  for (let p = 0; p + size < total; p += step) result.push(p);
  result.push(total - size);
  return result;
}

function crop(img: RgbaImage, x: number, y: number, w: number, h: number): RgbaImage {
  if (x === 0 && y === 0 && w === img.width && h === img.height) return img;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const start = ((y + row) * img.width + x) * 4;
    data.set(img.data.subarray(start, start + w * 4), row * w * 4);
  }
  return { data, width: w, height: h };
}

interface Point {
  x: number;
  y: number;
}

/** Tô trắng vùng bao quanh QR (toạ độ trong vùng quét, lệch offsetX/offsetY so với ảnh gốc). */
function mask(
  img: RgbaImage,
  location: {
    topLeftCorner: Point;
    topRightCorner: Point;
    bottomLeftCorner: Point;
    bottomRightCorner: Point;
  },
  offsetX: number,
  offsetY: number,
) {
  const corners = [
    location.topLeftCorner,
    location.topRightCorner,
    location.bottomLeftCorner,
    location.bottomRightCorner,
  ];
  const xs = corners.map((p) => p.x + offsetX);
  const ys = corners.map((p) => p.y + offsetY);
  const pad = (Math.max(...xs) - Math.min(...xs)) * 0.15;
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
  const x1 = Math.min(img.width, Math.ceil(Math.max(...xs) + pad));
  const y1 = Math.min(img.height, Math.ceil(Math.max(...ys) + pad));
  for (let y = y0; y < y1; y++) {
    img.data.fill(255, (y * img.width + x0) * 4, (y * img.width + x1) * 4);
  }
}
