import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * OAuth Client ID (loại "Web application") để extension tự đăng nhập Google. Lấy từ biến môi
 * trường GOOGLE_EXTENSION_CLIENT_ID (CI), hoặc file extension/google-oauth.json tải từ Google
 * Cloud Console (`{"web": {"client_id": ...}}`, file bị .gitignore). Không có thì extension vẫn
 * build được, chỉ không đăng nhập Google được.
 */
function googleClientId(): string {
  const fromEnv = process.env.GOOGLE_EXTENSION_CLIENT_ID?.trim();
  if (fromEnv) return fromEnv;
  const file = new URL("./google-oauth.json", import.meta.url);
  if (!existsSync(file)) return "";
  const config = JSON.parse(readFileSync(file, "utf8")) as {
    web?: { client_id?: string };
    client_id?: string;
  };
  return (config.web?.client_id ?? config.client_id ?? "").trim();
}

// Build trực tiếp ra dist/ để "Load unpacked" trong chrome://extensions.
// public/manifest.json và icons được copy nguyên vào dist/.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: "./",
  define: {
    __GOOGLE_CLIENT_ID__: JSON.stringify(googleClientId()),
  },
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome116",
    sourcemap: mode === "development",
    minify: mode !== "development",
    rollupOptions: {
      input: { popup: "popup.html", background: "src/background.ts" },
      output: {
        // manifest.json trỏ cố định tới background.js.
        entryFileNames: (chunk) =>
          chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
      },
    },
  },
}));
