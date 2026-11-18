import { resolve } from "node:path";
import { defineConfig, normalizePath } from "vite";
import { runtimeTerrain } from "./scripts/runtime-terrain.mjs";

export default defineConfig({
  plugins: [runtimeTerrain()],
  worker: { plugins: () => [runtimeTerrain({ emit: false })] },
  // Optical browser tests import the shared Three module from the dev bundle.
  optimizeDeps: { include: ["three"] },
  server: {
    fs: { deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/data/**",
      `${normalizePath(resolve(process.env.VOYAGER_DATA_DIR ?? "data"))}/**`] },
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.VOYAGER_API_PORT ?? 3000}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three", "three/addons/controls/OrbitControls.js"],
        },
      },
    },
  },
});
