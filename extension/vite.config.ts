import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build trực tiếp ra dist/ để "Load unpacked" trong chrome://extensions.
// public/manifest.json và icons được copy nguyên vào dist/.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: "./",
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
      input: { popup: "popup.html" },
    },
  },
}));
