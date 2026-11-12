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
  await expect(page.locator("#settings-target")).toHaveCount(0);
  await expect(page.locator(".settings-scope__node.is-current")).toContainText("Global");

  await page.goto(PROJECT_SETTINGS);
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

test("global target selector is hidden and the rail selects sections", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/settings");

  await expect(page.locator("#settings-target")).toHaveCount(0);
  await expect(page.locator(".settings-scope__node.is-current")).toContainText("Global");

  const rail = page.locator(".settings-console__rail-item");
  await expect(rail).toHaveCount(6);
  await expect(page.locator('.settings-console__rail-item[aria-current="page"]')).toContainText(
    "Agent",
  );

  await page.locator('.settings-console__rail-item[data-section="git"]').click();
  await expect(page.locator('.settings-console__rail-item[aria-current="page"]')).toContainText(
    "Git",
  );
  await expect(page.locator("#settings-git")).toBeVisible();
  await expect(page.locator("#settings-agent")).toBeHidden();

  await page.goto("/settings#settings-restart");
  await expect(page.locator("#settings-restart")).toBeVisible();
  await expect(page.locator('.settings-console__rail-item[aria-current="page"]')).toContainText(
    "Restart",
  );

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflow).toBe(false);
    await expect(page.locator("#settings-target")).toHaveCount(0);
  }

  await settle(page);
  expectNoPageErrors(errors);
});

test("swaps chrome, title, and active nav after a scoped client navigation", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, PROJECT_SETTINGS);

  await expect(page.locator("#breadcrumb-host")).toContainText("E2E Project One");
  await expect(page.locator("#breadcrumb-host")).toContainText("Settings");
  await expect(page.locator("#breadcrumb-host")).not.toContainText("alpha");
  await expect(page.locator("#breadcrumb-host")).toHaveAttribute("data-nav-id", "settings");
  await expect(page.locator("#sidebar-nav")).toHaveAttribute("data-nav-id", "settings");
  await expect(page).toHaveTitle("Settings - hanse");

  await page.locator("#settings-target").selectOption(APP_SETTINGS);

  await expect(page).toHaveURL(new RegExp(`${APP_SETTINGS}$`));
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#breadcrumb-host")).toContainText("alpha");
  await expect(page.locator("#breadcrumb-host")).toContainText("Settings");
  await expect(page.locator("#breadcrumb-host")).toHaveAttribute("data-nav-id", "settings");
  await expect(page.locator("#sidebar-nav")).toHaveAttribute("data-nav-id", "settings");
  await expect(page).toHaveTitle("Settings - hanse");
  await expect(page.locator("#route-announcer")).toHaveText("Settings");

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
