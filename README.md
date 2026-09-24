# Authenticator

App quản lý mã 2FA (TOTP) cho Windows gồm **app desktop** (Tauri v2 + React + Vite) và
**extension Chrome/Edge** (Manifest V3 + React + Vite) dùng chung code trong `packages/`.

```
authenticator-app/
├── packages/
│   ├── core/          # types, protocol native messaging, hàm format (TS)
│   └── ui/            # React components, hook useCodes, đọc QR, CSS dùng chung
├── desktop/           # Tauri v2
│   ├── src/           # frontend React
│   └── src-tauri/     # backend Rust: TOTP, vault mã hoá, named pipe, native host
└── extension/         # Chrome/Edge MV3, build ra extension/dist
```

## Yêu cầu

- Node.js 22+, pnpm 10+
- Rust (toolchain `x86_64-pc-windows-msvc`) và Visual Studio Build Tools (C++)
- WebView2 Runtime (có sẵn trên Windows 10/11 bản mới)

## Chạy dev

```bash
pnpm install

# App desktop (lần đầu compile Rust mất vài phút)
pnpm dev:desktop

# Extension: build ở chế độ watch ra extension/dist
pnpm dev:extension
```

Load extension:

1. Mở `chrome://extensions` (hoặc `edge://extensions`), bật **Developer mode**.
2. Bấm **Load unpacked** rồi chọn thư mục `extension/dist`.
3. Extension ID sẽ là `dhlimcjaejobpdoekahaiiojdgmmgkno`, cố định nhờ trường `key` trong
   `extension/public/manifest.json`.

App desktop **tự đăng ký native messaging host** (HKCU, không cần quyền admin) mỗi lần khởi động.
Nếu Chrome/Edge đang mở từ trước thì nên mở lại extension popup sau khi app chạy.

## Build bản phát hành

```bash
pnpm build:desktop     # installer NSIS trong desktop/src-tauri/target/release/bundle/nsis
pnpm build:extension   # zip thư mục extension/dist để đưa lên Chrome Web Store / Edge Add-ons
```

## Kiến trúc

```
Extension popup ──connectNative──▶ authenticator.exe (chế độ native host)
                  stdin/stdout          │  chỉ chuyển tiếp message
                                        ▼
                        \\.\pipe\com.authenticator.app
                                        │
                                        ▼
                        App desktop đang chạy (giữ vault đã mở khoá)
```

- **Một file exe, hai chế độ:** Chrome chạy lại `authenticator.exe` với tham số
  `chrome-extension://...`. Khi thấy tham số này, exe chạy ở chế độ native host
  (`src-tauri/src/native_host.rs`) thay vì mở cửa sổ.
- **Secret không rời khỏi app desktop:** extension chỉ nhận mã 6–8 số, issuer và label.
- **Vault** (`%APPDATA%\com.authenticator.app\vault.json`): dữ liệu mã hoá AES-256-GCM.
  Key lấy từ master password (Argon2id), hoặc nếu không đặt mật khẩu thì là key ngẫu nhiên được
  **Windows DPAPI** khoá theo tài khoản Windows (tự mở khoá khi mở app; file không mở được trên
  máy/user khác). Key chỉ nằm trong RAM khi vault mở và bị zeroize khi khoá.
- Protocol extension ↔ app (`packages/core/src/protocol.ts`): `ping`, `status`, `list_codes`, `add_uri` (nhận cả `otpauth-migration://`).

## Tính năng

- Master password **tuỳ chọn**: có thể không dùng, đặt, đổi hoặc bỏ mật khẩu sau trong ⚙ Bảo mật
- Thêm tài khoản bằng link `otpauth://`, ảnh QR hoặc nhập tay (SHA1/256/512, 6–8 số, chu kỳ tuỳ chỉnh)
- Import từ Google Authenticator: dán link `otpauth-migration://` hoặc ảnh QR export
  (nhiều tài khoản một lần, tự bỏ qua tài khoản trùng; dán nhiều link mỗi dòng một link)
- Quét ảnh QR: chọn **nhiều ảnh** một lúc, **Ctrl+V** ảnh chụp màn hình hoặc **kéo thả**;
  mỗi ảnh đọc được nhiều QR và tài khoản được import ngay
- Danh sách mã có đồng hồ đếm ngược, bấm để copy, tìm kiếm, xoá
- Extension: xem và copy mã, **điền mã vào trang** đang mở, **quét QR trên trang** để thêm tài khoản

## Kiểm thử

```bash
cd desktop/src-tauri && cargo test   # RFC 6238, otpauth/migration, vault, DPAPI, native messaging
pnpm test                            # đọc nhiều QR trong một ảnh (packages/ui)
pnpm typecheck
```

## Hướng phát triển tiếp

- Tự khoá vault sau một khoảng thời gian không dùng
- Export và backup mã hoá
- Xác nhận trong app desktop khi extension lần đầu xin mã (pairing)
- Xoá registry key native host khi gỡ cài đặt (NSIS uninstall hook)
- System tray: chạy ẩn khi đóng cửa sổ để extension luôn kết nối được
