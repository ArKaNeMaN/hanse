import { expect, test } from "@playwright/test";
import {
  collectPageErrors,
  expectNoPageErrors,
  PROJECT_ONE,
  settle,
  signIn,
} from "./support/helpers.js";

const CHROME_FIXTURE = {
  sidebarNav: '<p class="nav-label">Workbench</p>',
  breadcrumb: '<span class="crumb">Swapped SSH</span>',
  title: "SSH Swapped",
  active: "ssh",
  pendingCount: 0,
  sshPendingCount: 0,
};

test("deep links, target queries, refreshes, and history stay in the SPA document", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, `/ssh?target=${PROJECT_ONE}:alpha`);

  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#ui-fallback")).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "SSH hosts" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/ssh\\?target=${PROJECT_ONE}(?::|%3A)alpha$`));
  await expect(page.locator("#ssh-scope")).toHaveValue(`${PROJECT_ONE}:alpha`);
  await expect(page.getByText("Access for E2E Project One / alpha")).toBeVisible();

  await page.reload();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#ssh-scope")).toHaveValue(`${PROJECT_ONE}:alpha`);
  await expect(page.getByText("Access for E2E Project One / alpha")).toBeVisible();

  await page.goto("/ssh");
  await expect(page.locator("#ssh-scope")).toHaveValue("");
  await expect(page.getByText("Choose an application")).toBeVisible();

  await page.locator("#ssh-scope").selectOption(`${PROJECT_ONE}:alpha`);
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(new RegExp(`/ssh\\?target=${PROJECT_ONE}(?::|%3A)alpha$`));
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.getByText("Access for E2E Project One / alpha")).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/ssh$/);
  await expect(page.getByText("Choose an application")).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/ssh\\?target=${PROJECT_ONE}(?::|%3A)alpha$`));
  await expect(page.getByText("Access for E2E Project One / alpha")).toBeVisible();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);

  await settle(page);
  expectNoPageErrors(errors);
});

test("swaps chrome, title, and active nav after a scoped client navigation", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/ssh");

  await page.route(/\/api\/ui\/chrome\?/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(CHROME_FIXTURE),
    }),
  );

  await page.locator("#ssh-scope").selectOption(`${PROJECT_ONE}:alpha`);
  await page.getByRole("button", { name: "Apply" }).click();

  await expect(page).toHaveURL(new RegExp(`/ssh\\?target=${PROJECT_ONE}(?::|%3A)alpha$`));
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#breadcrumb-host")).toContainText("Swapped SSH");
  await expect(page.locator("#breadcrumb-host")).toHaveAttribute("data-nav-id", "ssh");
  await expect(page.locator("#sidebar-nav")).toHaveAttribute("data-nav-id", "ssh");
  await expect(page).toHaveTitle("SSH Swapped - hanse");

  await settle(page);
  expectNoPageErrors(errors);
});

test("?legacy=1 and the rollback servers serve the legacy SSH page", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/ssh");

  const legacy = await page.goto("/ssh?legacy=1");
  expect(legacy?.status()).toBe(200);
  await expect(page.locator("#hanse-boot")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "SSH hosts" })).toBeVisible();
  await expect(page.locator("#ssh-hosts")).toBeVisible();
  await expect(page.getByText("test-host").first()).toBeVisible();

  for (const origin of ["http://127.0.0.1:4311", "http://127.0.0.1:4312"]) {
    const response = await page.goto(`${origin}/ssh`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("#hanse-boot")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "SSH hosts" })).toBeVisible();
    await expect(page.locator("#ssh-hosts")).toBeVisible();
  }

  await settle(page);
  expectNoPageErrors(errors);
});

test("mounts without a fallback flash or console errors", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/ssh");

  await page.goto("/ssh", { waitUntil: "domcontentloaded" });
  expect(await page.locator("#ui-fallback").isVisible()).toBe(false);

  await expect(page.getByRole("heading", { name: "SSH hosts" })).toBeVisible();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#ui-fallback")).toHaveCount(0);

  await settle(page);
  expectNoPageErrors(errors);
});
