import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests start local HTTP servers and, under a full parallel run, can exceed the
    // 5 s default on a loaded host. Keep the suite bounded but stable.
    testTimeout: 15_000,
  },
});
