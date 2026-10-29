import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vue()],
  test: {
    // Integration tests start local HTTP servers and, under a full parallel run, can exceed the
    // 5 s default on a loaded host. Keep the suite bounded but stable.
    testTimeout: 15_000,
    projects: [
      {
        extends: true,
        test: {
          name: "server",
          environment: "node",
          include: ["test/**/*.test.ts", "test/**/*.test.mjs"],
          exclude: ["test/ui/**", "test/fixtures/**", "node_modules/**", "dist/**"],
          env: { HANSE_UI_LEGACY: "1" },
        },
      },
      {
        extends: true,
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["ui/**/*.test.ts", "test/ui/**/*.test.ts"],
          setupFiles: ["test/ui/setup.ts"],
        },
      },
    ],
  },
});
