import { defineConfig } from "@playwright/test";

const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

const token = "test-operator-token";
const reuseExistingServer = process.env.HANSE_E2E_REUSE === "1";

const routeSpecs = [
  "**/auth.spec.ts",
  "**/overview.spec.ts",
  "**/projects.spec.ts",
  "**/project-detail.spec.ts",
  "**/app.spec.ts",
  "**/handoffs.spec.ts",
  "**/settings.spec.ts",
  "**/skills.spec.ts",
  "**/ssh.spec.ts",
  "**/error.spec.ts",
];

function fixtureEnv(port: number, mode: "spa" | "legacy", extra: Record<string, string> = {}) {
  return {
    ...baseEnv,
    HANSE_E2E_PORT: String(port),
    HANSE_E2E_MODE: mode,
    HANSE_E2E_TOKEN: token,
    ...extra,
  };
}

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: process.env.CI === "true",
  timeout: 30_000,
  expect: { timeout: 7_500 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
  },
  projects: [
    {
      name: "spa",
      testMatch: [
        "**/overview.spec.ts",
        "**/spa-overview.spec.ts",
        "**/projects.spec.ts",
        "**/spa-projects.spec.ts",
        "**/project.spec.ts",
        "**/spa-project.spec.ts",
        "**/handoffs.spec.ts",
        "**/spa-handoffs.spec.ts",
      ],
      use: { baseURL: "http://127.0.0.1:4310" },
    },
    {
      name: "legacy",
      testMatch: routeSpecs,
      use: { baseURL: "http://127.0.0.1:4311" },
    },
    {
      name: "allowlist-empty",
      testMatch: ["**/overview.spec.ts", "**/projects.spec.ts", "**/handoffs.spec.ts"],
      use: { baseURL: "http://127.0.0.1:4312" },
    },
  ],
  webServer: [
    {
      command: "node --import tsx e2e/support/server.ts",
      url: "http://127.0.0.1:4310/healthz",
      reuseExistingServer,
      timeout: 60_000,
      env: fixtureEnv(4310, "spa", { HANSE_UI_LEGACY: "" }),
    },
    {
      command: "node --import tsx e2e/support/server.ts",
      url: "http://127.0.0.1:4311/healthz",
      reuseExistingServer,
      timeout: 60_000,
      env: fixtureEnv(4311, "legacy", { HANSE_UI_LEGACY: "1" }),
    },
    {
      command: "node --import tsx e2e/support/server.ts",
      url: "http://127.0.0.1:4312/healthz",
      reuseExistingServer,
      timeout: 60_000,
      env: fixtureEnv(4312, "spa", {
        HANSE_UI_LEGACY: "",
        HANSE_UI_SPA_ROUTES: "",
      }),
    },
  ],
});
