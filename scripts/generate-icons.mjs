// Tạo lại mọi icon (app desktop, extension, website) từ một file gốc trong assets/.
// Chạy: pnpm icons
import { execSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Ưu tiên SVG (sắc nét ở mọi kích thước); PNG thì nên vuông, tối thiểu 1024×1024.
const source = ["icon.svg", "icon.png"].map((f) => join(root, "assets", f)).find(existsSync);
if (!source) {
  console.error("Không tìm thấy assets/icon.svg hoặc assets/icon.png");
  process.exit(1);
}

function tauriIcon(output, pngSizes) {
  const sizes = pngSizes ? ` --png ${pngSizes}` : "";
  execSync(`pnpm --filter desktop exec tauri icon "${source}" -o "${output}"${sizes}`, {
    cwd: root,
    stdio: "inherit",
  });
}

function moveFile(dir, from, to) {
  rmSync(join(dir, to), { force: true });
  renameSync(join(dir, from), join(dir, to));
}

console.log(`Icon gốc: ${source}\n`);

// 1. App desktop (Tauri): .ico, .icns, các PNG trong tauri.conf.json.
const desktopIcons = join(root, "desktop", "src-tauri", "icons");
tauriIcon(desktopIcons);
// App chỉ build cho Windows, bỏ icon Android/iOS mà tauri icon tạo kèm.
rmSync(join(desktopIcons, "android"), { recursive: true, force: true });
rmSync(join(desktopIcons, "ios"), { recursive: true, force: true });

// 2. Extension Chrome/Edge: tên file khớp extension/public/manifest.json.
tauriIcon(join(root, "extension", "public", "icons"), "16,32,48,128");

// 3. Website GitHub Pages (docs/): logo 120×120 cho trang Branding của Google, favicon 32×32.
const docs = join(root, "docs");
tauriIcon(docs, "120,32");
moveFile(docs, "120x120.png", "logo.png");
moveFile(docs, "32x32.png", "favicon.png");

console.log("\nĐã tạo lại icon cho desktop, extension và website.");
