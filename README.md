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

Load extension (khi dev):

1. Mở `chrome://extensions` (hoặc `edge://extensions`), bật **Developer mode**.
2. Bấm **Load unpacked** rồi chọn thư mục `extension/dist`.
3. Extension ID sẽ là `dhlimcjaejobpdoekahaiiojdgmmgkno`, cố định nhờ trường `key` trong
   `extension/public/manifest.json`.

### Cài extension từ app (khi chưa lên Store)

`build.rs` nhúng `extension/dist` vào exe (`pnpm dev:desktop` / `pnpm build:desktop` build extension
trước). Trong app, nút 🧩 **Kết nối extension → Cài vào Chrome / Cài vào Edge**:

1. Giải nén extension vào `%APPDATA%\com.authenticator.app\extension\` và copy đường dẫn đó.
2. Mở `chrome://extensions` / `edge://extensions` (tìm trình duyệt qua registry *App Paths*).
3. Hướng dẫn người dùng bật **Developer mode** → **Load unpacked** → dán đường dẫn đã copy.

Chrome không cho app bên ngoài tự cài extension ngoài Store, nên vẫn cần các thao tác trên.
Khi app cập nhật, thư mục extension đã giải nén được cập nhật lúc khởi động; trình duyệt nạp bản
mới khi bấm Reload hoặc mở lại trình duyệt. Chưa build extension thì app vẫn build được, chỉ không
có nút cài (build.rs in cảnh báo).

App desktop **tự đăng ký native messaging host** (HKCU, không cần quyền admin) mỗi lần khởi động.
Nếu Chrome/Edge đang mở từ trước thì nên mở lại extension popup sau khi app chạy.

**Chạy nền ở khay hệ thống (Windows):** đóng cửa sổ chỉ ẩn app xuống tray (cạnh đồng hồ) để
extension luôn lấy được mã. Bấm icon để mở lại; menu chuột phải có **Khoá vault** và **Thoát**.
Không tạo được icon tray thì đóng cửa sổ là thoát như bình thường.

### Ghép đôi extension (`src-tauri/src/pairing.rs`)

Extension ID cố định nhờ `key` công khai trong manifest, nên extension khác (hoặc tiến trình khác
mở named pipe) có thể giả danh. Vì vậy mỗi extension phải được cho phép một lần:

1. Popup extension bấm **Kết nối với app** → hiện mã 6 số.
2. App desktop bật lên (kể cả khi đang ẩn ở tray) hỏi **Cho phép / Từ chối** kèm cùng mã đó.
3. Được cho phép thì extension nhận token (lưu trong `chrome.storage.local`) và gửi kèm mọi
   request; thiếu/sai token thì app trả `NOT_PAIRED`. App chỉ lưu SHA-256 của token trong
   `paired-extensions.json`.

Danh sách extension đã cho phép (và nút **Thu hồi**) nằm trong 🧩 **Kết nối extension**.

## Đăng nhập Google (đồng bộ qua Google Drive)

Nút **Đăng nhập Google** (logo G ở góc phải) dùng để đồng bộ / khôi phục vault qua thư mục
**`Authenticator Backup`** trong My Drive (file `vault-backup.json`).
Thư mục này xem/tải được trên drive.google.com; trong menu có nút **📂 Mở thư mục trên Drive**.
App dùng scope `drive.file`: chỉ thấy file do chính nó tạo, không đọc được file khác trong Drive.

- Vault có master password: bản trên Drive được mã hoá bằng master password, khôi phục xong cần
  nhập master password của bản sao lưu.
- Vault không mật khẩu: key do Windows DPAPI giữ, không mang sang máy khác được, nên bản trên
  Drive là danh sách tài khoản dạng **JSON không mã hoá**: ai mở được file trên Drive (hoặc được bạn
  chia sẻ file) đều thấy secret 2FA. Khôi phục xong vault mở sẵn, không cần mật khẩu.
  (Nếu bản trên Drive đang mã hoá thì đồng bộ hỏi master password của nó và giữ nguyên mã hoá.)

### Extension tự đăng nhập Google (không cần app desktop)

Popup extension có 2 tab: **App** (lấy mã từ app desktop như trên) và **Google Drive**. Tab Google
Drive đăng nhập Google ngay trong trình duyệt và dùng chung bản sao lưu `vault-backup.json` với app,
nên dùng được trên máy không cài app (hoặc trên macOS / Ubuntu, nơi chưa kết nối extension với app được).

- Lần đầu: tải bản sao lưu về; bản có master password thì nhập master password (giống trên app).
  Drive chưa có bản nào thì đặt master password để tạo vault mới ngay trong extension.
- Vault của extension lưu trong `chrome.storage.local` đúng định dạng file trên Drive (đã mã hoá nếu
  có master password). Key giải mã chỉ nằm trong `chrome.storage.session`: đóng trình duyệt hoặc bấm
  **Khoá** là phải nhập lại master password.
- Tự đồng bộ khi mở popup, sau khi quét QR thêm tài khoản và mỗi 15 phút ở nền (service worker),
  cùng quy tắc gộp với app (`extension/src/standalone/merge.ts` chép từ `sync.rs`): tài khoản bị xoá
  ở máy khác **không tự mất**, icon extension hiện dấu **!** để bạn xác nhận.
- App desktop không chạy thì popup tự chuyển sang tab Google Drive.
- Code: `extension/src/standalone/` (TOTP, đọc link otpauth, mã hoá Argon2id + AES-GCM, gộp, Drive).
  Test so chéo với Rust: extension giải mã bản do app tạo (`fixtures/rust-backup.json`) và app giải
  mã bản do extension tạo (test `opens_backup_sealed_by_extension` trong `vault.rs`).

Cấu hình một lần (OAuth Client riêng cho extension):

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials), **cùng project** với
   OAuth client của app desktop (scope `drive.file` chỉ cho thấy file do chính project đó tạo, khác
   project thì extension không thấy bản sao lưu của app).
2. **Create credentials → OAuth client ID → Web application**. Mục **Authorized redirect URIs** thêm
   `https://dhlimcjaejobpdoekahaiiojdgmmgkno.chromiumapp.org/` (ID cố định nhờ `key` trong
   manifest, giống nhau trên Chrome và Edge).
3. Tải file JSON về, lưu thành `extension/google-oauth.json` (bị .gitignore vì có client secret của
   client web, là bí mật thật), hoặc đặt biến môi
   trường `GOOGLE_EXTENSION_CLIENT_ID` lúc build. Chỉ cần client ID, extension không dùng client
   secret (luồng implicit qua `chrome.identity.launchWebAuthFlow`).
4. `pnpm build:extension` rồi bấm **Reload** ở trang extensions.

Release bằng GitHub Actions: thêm secret `GOOGLE_EXTENSION_CLIENT_ID` (chỉ client ID).

### Đồng bộ nhiều máy (`src-tauri/src/sync.rs`)

**Đồng bộ với Google Drive** tải bản trên Drive về, gộp với vault trên máy rồi tải bản đã gộp lên.
Khi đã đăng nhập Google, app **tự đồng bộ** lúc mở, vài giây sau mỗi lần thêm/xoá/khôi phục tài
khoản, và mỗi 15 phút (kể cả khi chạy nền). Tự đồng bộ chỉ chạy khi không có gì phải hỏi; có tài
khoản bị xoá ở máy khác, cần master password của bản sao lưu hoặc phiên Google hết hạn thì app hiện
thanh báo (và chấm vàng trên avatar) để bạn bấm **Xem**. Gộp theo `id` của từng tài khoản:

- Tài khoản chỉ có ở một bên → thêm vào bên kia.
- Tài khoản bị xoá ở một bên → **không tự xoá**: hộp thoại liệt kê từng tài khoản để đánh dấu xoá.
  Tài khoản bị xoá ở máy khác mặc định được **giữ lại** (phải tự đánh dấu mới xoá khỏi máy này);
  tài khoản bạn đã xoá trên máy này mặc định được đánh dấu. Không đánh dấu = giữ lại ở mọi máy.
- Đồng bộ / khôi phục chỉ áp dụng đúng bản trên Drive đã xem trước; nếu máy khác vừa ghi bản mới
  thì dừng lại để xem lại.
- Cùng một secret thêm riêng trên hai máy → gộp thành một.
- Bản trên Drive dùng master password khác → hỏi master password đó. Nếu trùng mật khẩu của máy
  này (chỉ khác salt) thì hai máy dùng chung key, lần sau không hỏi nữa; nếu khác thì cảnh báo là
  bản trên Drive sẽ chuyển sang mật khẩu của máy này.
- Trước khi tải lên, app kiểm tra bản trên Drive có vừa bị máy khác ghi không; có thì dừng và
  yêu cầu đồng bộ lại để không đè mất thay đổi của máy kia.

Xoá tài khoản là chuyển vào **Thùng rác** (nút ở cuối danh sách): khôi phục được, hoặc xoá vĩnh
viễn (bỏ hẳn secret, lan sang các máy khác khi đồng bộ). Mỗi lần đồng bộ/khôi phục làm thay đổi
vault, bản cũ được lưu trong `%APPDATA%\com.authenticator.app\history\` (giữ 10 bản gần nhất).

**Khôi phục từ Google Drive** (thay toàn bộ vault) hiện trước số tài khoản trên máy sẽ mất, kèm
cảnh báo nếu vault sẽ mất/đổi master password.

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
5. Repo đã có sẵn `desktop/src-tauri/google-oauth.json` (được commit): `build.rs` nhúng cấu hình
   vào app lúc build, nên mọi bản build (kể cả bản phát hành từ GitHub Actions) đăng nhập Google
   được ngay. Client loại *Desktop app* có client secret **không được coi là bí mật** (Google ghi
   rõ vậy, và nó vốn nằm trong file app phát hành), nên để công khai trong repo được.

   Muốn dùng OAuth client của riêng bạn: thay nội dung file đó bằng file JSON vừa tải
   (`{"installed": {"client_id": ..., "client_secret": ...}}` hoặc dạng phẳng), hoặc đặt file ở
   `%APPDATA%\com.authenticator.app\google-oauth.json` (được ưu tiên hơn cấu hình nhúng, không cần
   build lại).
6. Mở lại app → bấm **Đăng nhập Google** → trình duyệt mở trang đăng nhập → đồng ý → quay lại app.

Lưu ý:

- Ở chế độ *Testing*, Google thu hồi refresh token sau 7 ngày, khi đó app báo phiên hết hạn và
  bạn đăng nhập lại. Muốn dùng lâu dài thì **Publish app** trong OAuth consent screen.
- Refresh token lưu ở `%APPDATA%\com.authenticator.app\google-account.json`, được khoá bằng
  Windows DPAPI. Access token chỉ nằm trong RAM.
- Đăng nhập dùng OAuth cho app desktop: mở trình duyệt, Google chuyển hướng về
  `http://127.0.0.1:<cổng ngẫu nhiên>` do app mở tạm, có PKCE.
- Máy mới: ở màn hình tạo vault bấm **Khôi phục từ Google Drive**, sau đó nhập master password
  của bản sao lưu. Khôi phục trên máy đang có vault thì vault cũ được giữ trong thư mục `history`.

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
pnpm build:desktop     # build extension rồi installer NSIS (kèm extension) trong desktop/src-tauri/target/release/bundle/nsis
pnpm build:extension   # zip thư mục extension/dist để đưa lên Chrome Web Store / Edge Add-ons
```

### Tự cập nhật (`src-tauri/src/updater.rs`)

App tự cập nhật **âm thầm**, không hỏi người dùng, qua `latest.json` của GitHub Release mới nhất
(`tauri-plugin-updater`):

- **Mở app**: có bản mới thì tải, cài rồi tự khởi động lại (giao diện hiện "Đang cập nhật...").
- **Đang chạy nền ở tray**: kiểm tra mỗi 6 giờ, chỉ cài khi cửa sổ đang ẩn (không cắt ngang lúc
  đang dùng); cài xong app mở lại vẫn ẩn ở tray.
- Bản cập nhật phải đúng chữ ký: khoá công khai nằm trong `tauri.conf.json`
  (`plugins.updater.pubkey`), khoá bí mật chỉ nằm ở GitHub secret. Bản không đúng chữ ký bị từ chối.
- Windows: bộ cài NSIS chạy im lặng (`installMode: quiet`) rồi tự mở lại app. macOS: thay `.app`.
  Ubuntu: chỉ bản **AppImage** tự cập nhật được, bản `.deb` cài lại bằng tay.
- Chỉ tính bản đã **Publish** và không đánh dấu pre-release (`releases/latest`). Bản nháp chưa
  được cập nhật tới.
- Chạy dev (`pnpm dev:desktop`) thì không kiểm tra cập nhật.

Chuẩn bị một lần (khoá đã được tạo ở `~/.tauri/authenticator-updater.key`, **giữ cẩn thận, mất
khoá thì các bản đã cài không nhận được bản cập nhật nào nữa**): repo → **Settings → Secrets and
variables → Actions**, thêm:

- `TAURI_SIGNING_PRIVATE_KEY`: nội dung file `~/.tauri/authenticator-updater.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: nội dung file `~/.tauri/authenticator-updater.key.password`

Không có `TAURI_SIGNING_PRIVATE_KEY` (ví dụ repo fork) thì vẫn build và phát hành bình thường,
chỉ không ký bản cập nhật nên app đã cài không tự cập nhật lên bản đó. Build ở máy (`pnpm
build:desktop`) cũng không cần khoá: `bundle.createUpdaterArtifacts` mặc định tắt, workflow chỉ bật
khi có secret. **Không bao giờ commit khoá bí mật**: ai có khoá đều ký được "bản cập nhật" và app
sẽ tự cài nó âm thầm trên máy mọi người dùng. Fork muốn tự phát hành bản cập nhật thì tạo khoá riêng
(`pnpm tauri signer generate`) và thay `plugins.updater.pubkey`, `endpoints` trong `tauri.conf.json`.

### Release bằng GitHub Actions (chạy thủ công)

Workflow [`.github/workflows/release.yml`](.github/workflows/release.yml) chạy test, rồi build song song
và gắn vào GitHub Release `v<version>`:

| Nền tảng | File |
|---|---|
| Windows | `Authenticator_<version>_x64-setup.exe` (NSIS) |
| macOS (universal: Intel + Apple Silicon) | `Authenticator_<version>_universal.dmg` |
| Ubuntu / Debian | `Authenticator_<version>_amd64.deb`, `Authenticator_<version>_amd64.AppImage` |
| Extension Chrome / Edge | `authenticator-extension-<version>.zip` |

Cấu hình Google OAuth của app lấy từ `desktop/src-tauri/google-oauth.json` trong repo (hoặc secret
`GOOGLE_OAUTH_CONFIG` nếu muốn dùng client khác, secret được ưu tiên). Thiếu cả hai thì workflow
dừng ngay ở bước kiểm tra, không phát hành bản không đăng nhập Google được.
Extension tự đăng nhập Google cần thêm secret `GOOGLE_EXTENSION_CLIENT_ID` (repo → **Settings →
Secrets and variables → Actions**, xem mục *Extension tự đăng nhập Google*).

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
- Protocol extension ↔ app (`packages/core/src/protocol.ts`): `ping`, `pair_request`, `pair_status`,
  `status`, `list_codes`, `add_uri` (nhận cả `otpauth-migration://`). Trừ `ping` và hai lệnh ghép
  đôi, mọi lệnh cần token ghép đôi.

## Tính năng

- Master password **tuỳ chọn**: có thể không dùng, đặt, đổi hoặc bỏ mật khẩu sau trong ⚙ Bảo mật
- Thêm tài khoản bằng link `otpauth://`, ảnh QR hoặc nhập tay (SHA1/256/512, 6–8 số, chu kỳ tuỳ chỉnh)
- Import từ Google Authenticator: dán link `otpauth-migration://` hoặc ảnh QR export
  (nhiều tài khoản một lần, tự bỏ qua tài khoản trùng; dán nhiều link mỗi dòng một link)
- Quét ảnh QR: chọn **nhiều ảnh** một lúc, **Ctrl+V** ảnh chụp màn hình hoặc **kéo thả**;
  mỗi ảnh đọc được nhiều QR và tài khoản được import ngay
- **Quét bằng webcam**: giơ điện thoại có QR trước webcam. Export của Google Authenticator gồm nhiều
  QR (1/3, 2/3...) thì app tự gom, quét đủ cả lô thì hiện danh sách tài khoản để xác nhận. Đây là
  cách nhanh nhất vì Google Authenticator chặn chụp màn hình lúc xuất tài khoản
- Danh sách mã có đồng hồ đếm ngược, bấm để copy, tìm kiếm, xoá (vào Thùng rác, khôi phục được)
- **Group**: tạo / đổi tên / xoá group, một tài khoản thuộc được nhiều group (nút nhãn trên từng
  tài khoản). Thanh chip lọc theo group ở app và extension. Group **ẩn**: tài khoản chỉ thuộc các
  group ẩn không hiện ở "Tất cả" (bấm "n ẩn" hoặc tìm kiếm để thấy). Group đồng bộ qua Drive; xoá
  group không xoá tài khoản. Từ bản này file vault là **v3**: app / extension bản cũ sẽ báo cần
  cập nhật thay vì đồng bộ làm mất group, nên cập nhật app trên mọi máy
- Đồng bộ nhiều máy qua Google Drive, xoá ở đâu cũng phải xác nhận trước khi mất khỏi máy khác
- Extension: xem và copy mã, **điền mã vào trang** đang mở, **quét QR trên trang** để thêm tài khoản
- Extension **tự đăng nhập Google và tự đồng bộ** với Drive, dùng được khi không có app desktop
- Cài extension từ app (Load unpacked có hướng dẫn) khi extension chưa có trên Store
- **Tự cập nhật âm thầm** khi mở app và khi chạy nền ở tray (bản phát hành có chữ ký)

## Kiểm thử

```bash
cd desktop/src-tauri && cargo test   # RFC 6238, otpauth/migration, vault, đồng bộ, DPAPI, OAuth loopback, native messaging
pnpm test                            # đọc QR (packages/ui); TOTP, mã hoá, gộp của extension, so chéo với Rust
pnpm typecheck
```

## Hướng phát triển tiếp

- Tự khoá vault sau một khoảng thời gian không dùng
- Xoá registry key native host khi gỡ cài đặt (NSIS uninstall hook)
- Tuỳ chọn khởi động cùng Windows (ẩn sẵn ở tray)
