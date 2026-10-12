import { defineConfig } from "vite";

export default defineConfig({
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
