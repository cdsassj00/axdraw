import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vite";

// One id per build. The app compares it with /version.json to notice that a
// newer version has been deployed while a tab was left open.
const BUILD_ID = String(Date.now());

// Base path is configurable so the app can be served from a subdirectory
// (e.g. GitHub Pages at /axdraw/).
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  // Playwright needs a predictable preview port for `npm run test:e2e`.
  preview: { port: 4173 },
  build: {
    target: "es2020",
    outDir: "dist",
    assetsDir: "assets",
  },
  plugins: [
    {
      name: "axdraw-version",
      writeBundle(options) {
        writeFileSync(join(options.dir ?? "dist", "version.json"), JSON.stringify({ build: BUILD_ID }));
      },
    },
  ],
});
