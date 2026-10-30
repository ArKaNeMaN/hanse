import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const repositoryRoot = fileURLToPath(new URL(".", import.meta.url));

/**
 * The coordinator owns the HTML document; Vite only builds the client entry under `assets/ui/`.
 * `base` must match `devModuleUrls()` in `src/http/spa.ts`.
 */
export default defineConfig({
  root: "ui",
  base: "/assets/ui/",
  plugins: [vue()],
  // The shared chat-highlight controller instantiates the existing Prism worker as a module worker.
  // Its worker imports chat-diff/vendor modules, so Rollup must emit ES rather than IIFE.
  worker: { format: "es" },
  build: {
    outDir: "../assets/ui",
    emptyOutDir: true,
    manifest: true,
    assetsDir: "",
    rollupOptions: {
      input: "ui/main.ts",
    },
  },
  server: {
    // `ui/` imports `src/shared/routes.ts`, which lives outside the Vite root.
    fs: {
      allow: [repositoryRoot],
    },
    cors: {
      origin: [/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/],
    },
    allowedHosts: ["localhost", "127.0.0.1"],
  },
});
