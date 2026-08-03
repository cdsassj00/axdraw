import { defineConfig } from "vite";

// Base path is configurable so the app can be served from a subdirectory
// (e.g. GitHub Pages at /axdraw/).
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  // Playwright needs a predictable preview port for `npm run test:e2e`.
  preview: { port: 4173 },
  build: {
    target: "es2020",
    outDir: "dist",
    assetsDir: "assets",
  },
});
