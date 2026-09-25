# Assets dùng chung

Thư mục này chứa **file gốc** của mọi icon trong project. Không sửa trực tiếp các icon đã tạo ra;
thay file gốc ở đây rồi chạy lại lệnh tạo icon.

| File | Dùng cho |
|---|---|
| `icon.svg` | Logo app. Từ file này tạo ra icon app desktop, icon extension và logo website |
| `icons/*.svg` | Icon giao diện (nút, trạng thái) dùng chung cho app desktop và extension |

## Icon giao diện (`icons/`)

Dùng trong code bằng `<Icon name="camera" />` (component ở `packages/ui/src/Icon.tsx`).
**Thay file SVG là đổi icon ở mọi nơi**, không cần sửa code; build lại app / extension là xong.

| File | Dùng ở |
|---|---|
| `camera.svg` | Nút chọn ảnh QR (desktop), nút quét QR trên trang (extension) |
| `plus.svg` | Nút "Thêm" tài khoản |
| `puzzle.svg` | Nút "Kết nối extension" |
| `settings.svg` | Nút "Bảo mật", dòng gợi ý ở màn hình tạo vault |
| `lock.svg` | Nút "Khoá vault", trạng thái có master password |
| `lock-open.svg` | Trạng thái không dùng mật khẩu |
| `shield-lock.svg` | Tiêu đề màn hình mở khoá / tạo vault, tiêu đề popup extension |
| `check.svg` | "Đã đăng ký native host" |
| `cloud-upload.svg` | "Sao lưu lên Google Drive" |
| `folder-open.svg` | "Mở thư mục trên Drive" |
| `download.svg` | "Khôi phục từ Google Drive" |

Yêu cầu khi vẽ / thay icon:

- `viewBox="0 0 24 24"`, không đặt `width` / `height` cố định (component tự chỉnh kích thước).
- Dùng `stroke="currentColor"` hoặc `fill="currentColor"` để icon tự lấy màu chữ (sáng / tối, màu lỗi…).
- Không dùng `<script>` hay thuộc tính `style`; SVG được chèn thẳng vào giao diện.
- Thêm icon mới: bỏ file `ten-icon.svg` vào đây và thêm `"ten-icon"` vào kiểu `IconName` trong
  `packages/ui/src/Icon.tsx`.

## Thay logo

1. Thay `assets/icon.svg` bằng logo mới (giữ nguyên tên file).
   Cũng có thể dùng `assets/icon.png` (hình vuông, tối thiểu 1024×1024, nền trong suốt nếu muốn);
   nếu có cả hai thì `icon.svg` được ưu tiên, nên xoá file cũ đi.
2. Tạo lại icon bằng `tauri icon` (chạy trong thư mục `desktop/`, Git Bash). Nếu dùng PNG thì
   đổi `icon.svg` thành `icon.png`:
   ```bash
   cd desktop

   # App desktop: .ico, .icns, các PNG trong tauri.conf.json (bỏ icon mobile tạo kèm)
   pnpm tauri icon ../assets/icon.svg
   rm -rf src-tauri/icons/android src-tauri/icons/ios

   # Extension: tên file khớp extension/public/manifest.json
   pnpm tauri icon ../assets/icon.svg -o ../extension/public/icons --png 16,32,48,128

   # Website: logo 120×120 cho trang Branding của Google, favicon 32×32
   pnpm tauri icon ../assets/icon.svg -o ../docs --png 120,32
   mv -f ../docs/120x120.png ../docs/logo.png
   mv -f ../docs/32x32.png ../docs/favicon.png
   ```
3. Build lại app / extension. Website (`docs/`) cập nhật sau khi push.

## Các icon được tạo ra

| Nơi | File | Dùng cho |
|---|---|---|
| `desktop/src-tauri/icons/` | `icon.ico`, `icon.icns`, `32x32.png`, `128x128.png`, `128x128@2x.png`, … | Icon app Windows, installer |
| `extension/public/icons/` | `16x16.png`, `32x32.png`, `48x48.png`, `128x128.png` | Icon extension (khớp `manifest.json`) |
| `docs/` | `logo.png` (120×120), `favicon.png` (32×32) | Website GitHub Pages, logo trang Branding của Google |

> Nếu đã tải logo lên trang Branding của Google Cloud, đổi logo sẽ phải tải lại `docs/logo.png`
> (có thể phải xác minh thương hiệu lại).

Màu sắc giao diện dùng chung nằm ở `packages/ui/src/styles.css` (các biến `--auth-*`).
Logo Google trong nút đăng nhập là logo chính thức của Google, không thay.
