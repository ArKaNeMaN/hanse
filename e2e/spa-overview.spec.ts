import { expect, test } from "@playwright/test";
import { collectPageErrors, expectNoPageErrors, settle, signIn } from "./support/helpers.js";

const CHROME_FIXTURE = {
  sidebarNav: '<p class="nav-label">Workbench</p>',
  breadcrumb: '<span class="crumb">Swapped Projects</span>',
  title: "Projects",
  active: "projects",
  pendingCount: 0,
  sshPendingCount: 0,
};

test("deep links, refreshes, and navigates client-side to projects", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/");

  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#ui-fallback")).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "Fleet overview" })).toBeVisible();
  await expect(page.getByRole("link", { name: "E2E Project One", exact: true })).toBeVisible();

  await page.route(/\/api\/ui\/chrome\?/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(CHROME_FIXTURE),
    }),
  );

  await page.locator("#main").getByRole("link", { name: "All projects", exact: true }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();

  // The document was not reloaded: same boot marker, swapped chrome fragment.
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#breadcrumb-host")).toContainText("Swapped Projects");
  await expect(page.locator("#breadcrumb-host")).toHaveAttribute("data-nav-id", "projects");
  await expect(page.locator("#sidebar-nav")).toHaveAttribute("data-nav-id", "projects");
  await expect(page).toHaveTitle("Projects - hanse");

  await page.reload();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Fleet overview" })).toBeVisible();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);

  await page.goForward();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("?legacy=1 serves the legacy overview document", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/");

  const response = await page.goto("/?legacy=1");
  expect(response?.status()).toBe(200);
  await expect(page.locator("#hanse-boot")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Fleet overview" })).toBeVisible();
  await expect(page.locator(".watch-strip")).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("the legacy and empty-allowlist servers still serve the overview", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/");

  for (const origin of ["http://127.0.0.1:4311", "http://127.0.0.1:4312"]) {
    const response = await page.goto(`${origin}/`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("#hanse-boot")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Fleet overview" })).toBeVisible();
    await expect(page.getByRole("link", { name: "E2E Project One", exact: true })).toBeVisible();
  }

  await settle(page);
  expectNoPageErrors(errors);
});

test("mounts without a fallback flash or console errors", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/");

  await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(await page.locator("#ui-fallback").isVisible()).toBe(false);

  await expect(page.getByRole("heading", { name: "Fleet overview" })).toBeVisible();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#ui-fallback")).toHaveCount(0);

  await settle(page);
  expectNoPageErrors(errors);
});

test("records the overview first-load transfer without an arbitrary budget", async ({ page }) => {
  await signIn(page, "/");

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });

  const urls = new Map<string, string>();
  const lengths = new Map<string, number>();
  cdp.on("Network.responseReceived", (event) => {
    urls.set(event.requestId, event.response.url);
  });
  cdp.on("Network.loadingFinished", (event) => {
    const url = urls.get(event.requestId);
    if (url !== undefined) {
      lengths.set(url, event.encodedDataLength);
    }
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Fleet overview" })).toBeVisible();
  await settle(page);
  await page.waitForTimeout(500);

  const entries = [...lengths.entries()];
  const sum = (predicate: (url: string) => boolean): number =>
    entries.filter(([url]) => predicate(url)).reduce((total, [, size]) => total + size, 0);

  const documentBytes = sum((url) => new URL(url).pathname === "/");
  const cssBytes = sum((url) => new URL(url).pathname === "/assets/app.css");
  const entryBytes = sum((url) => /\/assets\/ui\/main-[^/]+\.js$/.test(url));
  const routeBytes = sum((url) => /\/assets\/ui\/OverviewPage-[^/]+\.js$/.test(url));
  const total = documentBytes + cssBytes + entryBytes + routeBytes;

  test.info().annotations.push({
    type: "transfer",
    description: `document=${documentBytes} css=${cssBytes} entry=${entryBytes} route=${routeBytes} total=${total}`,
  });
  process.stdout.write(
    `/ first load transfer: document=${documentBytes} css=${cssBytes} entry=${entryBytes} route=${routeBytes} total=${total} bytes\n`,
  );

  expect(entryBytes).toBeGreaterThan(0);
  expect(routeBytes).toBeGreaterThan(0);
});
