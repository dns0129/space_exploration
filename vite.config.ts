import { defineConfig } from "vite";
import { runtimeTerrain } from "./scripts/runtime-terrain.mjs";

export default defineConfig({
  plugins: [runtimeTerrain()],
  worker: { plugins: () => [runtimeTerrain({ emit: false })] },
  // Optical browser tests import the shared Three module from the dev bundle.
  optimizeDeps: { include: ["three"] },
  server: {
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
