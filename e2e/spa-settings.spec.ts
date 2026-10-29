import { expect, test } from "@playwright/test";
import {
  collectPageErrors,
  expectNoPageErrors,
  PROJECT_ONE,
  settle,
  signIn,
} from "./support/helpers.js";
import {
  E2E_HTTPS_TOKEN,
  E2E_KNOWN_HOSTS_SENTINEL,
  E2E_PRIVATE_KEY_SENTINEL,
  E2E_PROVIDER_SECRET,
} from "./support/seed.js";

const APP_SETTINGS = `/projects/${PROJECT_ONE}/apps/alpha/settings`;
const PROJECT_SETTINGS = `/projects/${PROJECT_ONE}/settings`;

const CHROME_FIXTURE = {
  sidebarNav: '<p class="nav-label">Workbench</p>',
  breadcrumb: '<span class="crumb">Swapped Settings</span>',
  title: "Settings Swapped",
  active: "settings",
  pendingCount: 0,
  sshPendingCount: 0,
};

test("deep links, refreshes, and scope navigation stay in the SPA document", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, APP_SETTINGS);

  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#ui-fallback")).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "alpha settings" })).toBeVisible();
  await expect(page).toHaveTitle("Settings - hanse");

  await page.reload();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "alpha settings" })).toBeVisible();

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await page.locator("#settings-target").selectOption(PROJECT_SETTINGS);
  await expect(page).toHaveURL(new RegExp(`${PROJECT_SETTINGS}$`));
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "E2E Project One settings" })).toBeVisible();

  await page.locator("#settings-target").selectOption(APP_SETTINGS);
  await expect(page).toHaveURL(new RegExp(`${APP_SETTINGS}$`));
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "alpha settings" })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${PROJECT_SETTINGS}$`));
  await expect(page.getByRole("heading", { name: "E2E Project One settings" })).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`${APP_SETTINGS}$`));
  await expect(page.getByRole("heading", { name: "alpha settings" })).toBeVisible();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);

  await settle(page);
  expectNoPageErrors(errors);
});

test("swaps chrome, title, and active nav after a scoped client navigation", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/settings");

  await page.route(/\/api\/ui\/chrome\?/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(CHROME_FIXTURE),
    }),
  );

  await page.locator("#settings-target").selectOption(PROJECT_SETTINGS);

  await expect(page).toHaveURL(new RegExp(`${PROJECT_SETTINGS}$`));
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#breadcrumb-host")).toContainText("Swapped Settings");
  await expect(page.locator("#breadcrumb-host")).toHaveAttribute("data-nav-id", "settings");
  await expect(page.locator("#sidebar-nav")).toHaveAttribute("data-nav-id", "settings");
  await expect(page).toHaveTitle("Settings Swapped - hanse");

  await settle(page);
  expectNoPageErrors(errors);
});

test("?legacy=1 and the rollback servers serve the legacy settings page", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/settings");

  const legacy = await page.goto("/settings?legacy=1");
  expect(legacy?.status()).toBe(200);
  await expect(page.locator("#hanse-boot")).toHaveCount(0);
  await expect(page.locator("#settings-agent")).toBeVisible();

  for (const origin of ["http://127.0.0.1:4311", "http://127.0.0.1:4312"]) {
    const response = await page.goto(`${origin}/settings`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("#hanse-boot")).toHaveCount(0);
    await expect(page.locator("#settings-agent")).toBeVisible();
    await expect(page.locator("#setting-llm-model")).toBeVisible();
  }

  await settle(page);
  expectNoPageErrors(errors);
});

test("mounts without a fallback flash, console errors, or secret text", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, APP_SETTINGS);

  await page.goto(APP_SETTINGS, { waitUntil: "domcontentloaded" });
  expect(await page.locator("#ui-fallback").isVisible()).toBe(false);

  await expect(page.getByRole("heading", { name: "alpha settings" })).toBeVisible();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#ui-fallback")).toHaveCount(0);

  const content = await page.content();
  expect(content).not.toContain(E2E_PROVIDER_SECRET);
  expect(content).not.toContain(E2E_HTTPS_TOKEN);
  expect(content).not.toContain(E2E_PRIVATE_KEY_SENTINEL);
  expect(content).not.toContain(E2E_KNOWN_HOSTS_SENTINEL);

  await settle(page);
  expectNoPageErrors(errors);
});
