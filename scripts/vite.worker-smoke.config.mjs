import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Standalone module-worker build used only by `npm run check:chat-worker`.
 *
 * It builds the existing `assets/chat-highlight-worker.js` (which imports the shared `chat-diff.js`
 * and the vendored Prism bundle) into a temporary directory so the smoke can instantiate and
 * tokenize inside the *built* worker. Nothing here is part of the product build.
 */
export default defineConfig({
  root,
  logLevel: "silent",
  build: {
    outDir: process.env.CHAT_WORKER_SMOKE_OUT ?? path.join(root, "node_modules", ".cache"),
    emptyOutDir: true,
    minify: false,
    target: "es2022",
    rollupOptions: {
      input: path.join(root, "assets", "chat-highlight-worker.js"),
      output: {
        entryFileNames: "chat-highlight-worker.js",
        chunkFileNames: "[name]-[hash].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
