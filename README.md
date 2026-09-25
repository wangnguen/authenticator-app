# Authenticator

App quản lý mã 2FA (TOTP) cho Windows gồm **app desktop** (Tauri v2 + React + Vite) và
**extension Chrome/Edge** (Manifest V3 + React + Vite) dùng chung code trong `packages/`.

```
authenticator-app/
├── assets/            # file gốc của logo (icon.svg) và icon giao diện
├── packages/
│   ├── core/          # types, protocol native messaging, hàm format (TS)
│   └── ui/            # React components, hook useCodes, đọc QR, CSS dùng chung
├── desktop/           # Tauri v2
│   ├── src/           # frontend React
│   └── src-tauri/     # backend Rust: TOTP, vault mã hoá, named pipe, native host
├── extension/         # Chrome/Edge MV3, build ra extension/dist
└── docs/              # website GitHub Pages (trang chủ, chính sách bảo mật, điều khoản)
```

**Đổi logo:** thay `assets/icon.svg` rồi tạo lại icon (lệnh và chi tiết: [assets/README.md](assets/README.md)).

## Yêu cầu

- Node.js 22+, pnpm 11+
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

## Đăng nhập Google (sao lưu lên Google Drive)

Nút **Đăng nhập Google** (logo G ở góc phải) dùng để sao lưu / khôi phục vault vào thư mục
**`Authenticator Backup`** trong My Drive (file `vault-backup.json`, mỗi lần sao lưu ghi đè).
Thư mục này xem/tải được trên drive.google.com; trong menu có nút **📂 Mở thư mục trên Drive**.
App dùng scope `drive.file`: chỉ thấy file do chính nó tạo, không đọc được file khác trong Drive.

- Vault có master password: sao lưu nguyên file vault đã mã hoá, khôi phục xong cần nhập master
  password của bản sao lưu.
- Vault không mật khẩu: key do Windows DPAPI giữ, không mang sang máy khác được, nên sao lưu
  danh sách tài khoản dạng **JSON không mã hoá**: ai mở được file trên Drive (hoặc được bạn chia
  sẻ file) đều thấy secret 2FA. Khôi phục xong vault mở sẵn, không cần mật khẩu.

Cần tạo OAuth Client ID một lần (khoảng 5 phút):

1. Vào [Google Cloud Console](https://console.cloud.google.com/), tạo project mới (ví dụ `authenticator-app`).
2. **APIs & Services → Library**: tìm **Google Drive API** → **Enable**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type **External**, điền tên app, email hỗ trợ.
   - **Data access / Scopes**: thêm `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`,
     `.../auth/drive.file`.
   - **Audience / Test users**: thêm Gmail của bạn (khi app ở chế độ *Testing* chỉ test user
     đăng nhập được).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Desktop app** → **Create** → **Download JSON**.
5. Đổi tên file vừa tải thành `google-oauth.json` và copy vào:
   ```
   %APPDATA%\com.authenticator.app\google-oauth.json
   ```
   (File có dạng `{"installed": {"client_id": ..., "client_secret": ...}}`. Không commit file này.)

   Hoặc đặt file ở `desktop/src-tauri/google-oauth.json` (đã có trong `.gitignore`): `build.rs`
   sẽ nhúng cấu hình vào exe lúc build, máy nào chạy bản build đó cũng đăng nhập được.
   File trong `%APPDATA%` được ưu tiên hơn cấu hình nhúng.
6. Mở lại app → bấm **Đăng nhập Google** → trình duyệt mở trang đăng nhập → đồng ý → quay lại app.

Lưu ý:

- Ở chế độ *Testing*, Google thu hồi refresh token sau 7 ngày, khi đó app báo phiên hết hạn và
  bạn đăng nhập lại. Muốn dùng lâu dài thì **Publish app** trong OAuth consent screen.
- Refresh token lưu ở `%APPDATA%\com.authenticator.app\google-account.json`, được khoá bằng
  Windows DPAPI. Access token chỉ nằm trong RAM.
- Đăng nhập dùng OAuth cho app desktop: mở trình duyệt, Google chuyển hướng về
  `http://127.0.0.1:<cổng ngẫu nhiên>` do app mở tạm, có PKCE.
- Máy mới: ở màn hình tạo vault bấm **Khôi phục từ Google Drive**, sau đó nhập master password
  của bản sao lưu. Khôi phục trên máy đang có vault thì vault cũ được giữ ở `vault.json.bak`.

### Publish app để mọi tài khoản Google đăng nhập được

Thư mục [`docs/`](docs/) là website cho GitHub Pages: trang chủ, chính sách bảo mật, điều khoản
(tiếng Việt + English) và logo 120×120 — đủ cho trang **Branding** của Google.

1. **Email liên hệ** trên các trang: `duc.phan33@ntq-solution.com.vn` (sửa trong `docs/*.html` nếu đổi).
2. **Bật GitHub Pages**: repo trên GitHub → **Settings → Pages** → *Source*: **Deploy from a branch**
   → Branch **main**, thư mục **/docs** → **Save**. Sau 1–2 phút website có ở
   `https://wangnguen.github.io/authenticator-app/`.
3. **Xác minh domain trong [Google Search Console](https://search.google.com/search-console)**
   (bằng đúng tài khoản Google sở hữu project trên Google Cloud):
   - **Add property** → **URL prefix** → `https://wangnguen.github.io/authenticator-app/`.
   - Chọn cách **HTML tag**, copy thẻ `<meta name="google-site-verification" ...>`, dán vào
     `docs/index.html` (chỗ có comment "Xác minh Google Search Console"), commit + push, đợi Pages
     cập nhật rồi bấm **Verify**.
   - Nếu trang Branding vẫn báo domain `wangnguen.github.io` chưa xác minh: tạo thêm repo
     `wangnguen.github.io` (GitHub Pages của tài khoản) chứa `index.html` có thẻ meta đó, rồi xác
     minh property `https://wangnguen.github.io/` (gốc domain).
4. **Branding** (https://console.cloud.google.com/auth/branding):

   | Ô | Giá trị |
   |---|---|
   | App name | `Authenticator` |
   | User support email | email của bạn |
   | App logo | `docs/logo.png` (không bắt buộc; có logo thì Google thường yêu cầu brand verification) |
   | Application home page | `https://wangnguen.github.io/authenticator-app/` |
   | Application privacy policy link | `https://wangnguen.github.io/authenticator-app/privacy.html` |
   | Application terms of service link | `https://wangnguen.github.io/authenticator-app/terms.html` |
   | Authorized domains | `wangnguen.github.io` |
   | Developer contact information | email của bạn |

5. **Data Access**: chỉ giữ `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`,
   `.../auth/drive.file` (đều là scope không nhạy cảm → không cần review scope).
6. **Audience → Publish app → Confirm**. Nếu Google yêu cầu, gửi brand verification ở
   **Verification Center** (thường vài ngày làm việc).

## Build bản phát hành

Build trên máy:

```bash
pnpm build:desktop     # installer NSIS trong desktop/src-tauri/target/release/bundle/nsis
pnpm build:extension   # zip thư mục extension/dist để đưa lên Chrome Web Store / Edge Add-ons
```

### Release bằng GitHub Actions (chạy thủ công)

Workflow [`.github/workflows/release.yml`](.github/workflows/release.yml) chạy test, rồi build song song
và gắn vào GitHub Release `v<version>`:

| Nền tảng | File |
|---|---|
| Windows | `Authenticator_<version>_x64-setup.exe` (NSIS) |
| macOS (universal: Intel + Apple Silicon) | `Authenticator_<version>_universal.dmg` |
| Ubuntu / Debian | `Authenticator_<version>_amd64.deb`, `Authenticator_<version>_amd64.AppImage` |
| Extension Chrome / Edge | `authenticator-extension-<version>.zip` |

Chuẩn bị một lần: repo trên GitHub → **Settings → Secrets and variables → Actions → New repository
secret**, tên `GOOGLE_OAUTH_CONFIG`, giá trị là toàn bộ nội dung file `desktop/src-tauri/google-oauth.json`.
Không có secret này thì bản build vẫn chạy nhưng không đăng nhập Google được.

Mỗi lần phát hành:

1. Push code cần phát hành lên GitHub.
2. GitHub → **Actions → Release → Run workflow** → nhập **version** (dạng `x.y.z`, ví dụ `0.2.0`).
   Version này được ghi vào app và extension lúc build, không cần sửa file trong repo.
3. Mặc định tạo **bản nháp**; kiểm tra file ở trang **Releases** rồi bấm **Publish release**.
   Bỏ chọn *draft* nếu muốn phát hành luôn.

Chạy lại với version đã *publish* sẽ bị từ chối (phải tăng version); chạy lại khi còn là bản nháp
thì file cũ được ghi đè.

Lưu ý:

- App chưa ký số: Windows hiện cảnh báo SmartScreen; macOS dùng chữ ký ad-hoc nên lần đầu phải
  chuột phải → **Open**.
- Trên macOS và Ubuntu hiện chỉ dùng được vault **có master password**: chế độ không mật khẩu và
  lưu phiên Google dùng Windows DPAPI, kết nối extension dùng named pipe và registry của Windows.

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
cd desktop/src-tauri && cargo test   # RFC 6238, otpauth/migration, vault, DPAPI, OAuth loopback, native messaging
pnpm test                            # đọc nhiều QR trong một ảnh (packages/ui)
pnpm typecheck
```

## Hướng phát triển tiếp

- Tự khoá vault sau một khoảng thời gian không dùng
- Tự sao lưu lên Google Drive mỗi khi thêm/xoá tài khoản
- Xác nhận trong app desktop khi extension lần đầu xin mã (pairing)
- Xoá registry key native host khi gỡ cài đặt (NSIS uninstall hook)
- System tray: chạy ẩn khi đóng cửa sổ để extension luôn kết nối được
