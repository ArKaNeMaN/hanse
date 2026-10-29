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
  breadcrumb: '<span class="crumb">Swapped Project</span>',
  title: "Project Swapped",
  active: "project",
  pendingCount: 0,
  sshPendingCount: 0,
};

test("deep links, refreshes, swaps chrome, and restores history", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, `/projects/${PROJECT_ONE}`);

  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#ui-fallback")).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "E2E Project One" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Applications" })).toBeVisible();

  await page.route(/\/api\/ui\/chrome\?/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(CHROME_FIXTURE),
    }),
  );

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Fleet overview" })).toBeVisible();
  await page.getByRole("link", { name: "E2E Project One", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ONE}$`));
  await expect(page.getByRole("heading", { name: "E2E Project One" })).toBeVisible();
  await expect(page.locator("#breadcrumb-host")).toContainText("Swapped Project");
  await expect(page.locator("#breadcrumb-host")).toHaveAttribute("data-nav-id", "project");
  await expect(page.locator("#sidebar-nav")).toHaveAttribute("data-nav-id", "project");
  await expect(page).toHaveTitle("Project Swapped - hanse");

  await page.reload();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "E2E Project One" })).toBeVisible();

  await page.goto("/projects");
  await page.getByRole("link", { name: "E2E Project One", exact: true }).click();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "E2E Project One" })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);

  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ONE}$`));
  await expect(page.getByRole("heading", { name: "E2E Project One" })).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("?legacy=1 serves the legacy project document", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, `/projects/${PROJECT_ONE}`);

  const response = await page.goto(`/projects/${PROJECT_ONE}?legacy=1`);
  expect(response?.status()).toBe(200);
  await expect(page.locator("#hanse-boot")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "E2E Project One" })).toBeVisible();
  await expect(page.locator("#add-app")).toBeAttached();
  await expect(page.locator("#new-handoff")).toBeAttached();

  await settle(page);
  expectNoPageErrors(errors);
});

test("the legacy and empty-allowlist servers still serve the project page", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, `/projects/${PROJECT_ONE}`);

  for (const origin of ["http://127.0.0.1:4311", "http://127.0.0.1:4312"]) {
    const response = await page.goto(`${origin}/projects/${PROJECT_ONE}`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("#hanse-boot")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "E2E Project One" })).toBeVisible();
    await expect(page.locator("#add-app")).toBeAttached();
  }

  await settle(page);
  expectNoPageErrors(errors);
});

test("an application link navigates client-side after the cutover", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, `/projects/${PROJECT_ONE}`);

  let documentLoads = 0;
  page.on("request", (request) => {
    if (request.resourceType() === "document") documentLoads += 1;
  });

  await page
    .locator('section[aria-labelledby="apps-title"]')
    .getByRole("link", { name: "alpha", exact: true })
    .click();

  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ONE}/apps/alpha$`));
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "alpha", exact: true })).toBeVisible();
  expect(documentLoads).toBe(0);

  await settle(page);
  expectNoPageErrors(errors);
});

test("mounts without a fallback flash or console errors", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, `/projects/${PROJECT_ONE}`);

  await page.goto(`/projects/${PROJECT_ONE}`, { waitUntil: "domcontentloaded" });
  expect(await page.locator("#ui-fallback").isVisible()).toBe(false);

  await expect(page.getByRole("heading", { name: "E2E Project One" })).toBeVisible();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#ui-fallback")).toHaveCount(0);

  await settle(page);
  expectNoPageErrors(errors);
});

test("records the project first-load transfer", async ({ page }) => {
  await signIn(page, `/projects/${PROJECT_ONE}`);

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

  await page.goto(`/projects/${PROJECT_ONE}`);
  await expect(page.getByRole("heading", { name: "E2E Project One" })).toBeVisible();
  await settle(page);
  await page.waitForTimeout(500);

  const entries = [...lengths.entries()];
  const sum = (predicate: (url: string) => boolean): number =>
    entries.filter(([url]) => predicate(url)).reduce((total, [, size]) => total + size, 0);

  const documentBytes = sum((url) => new URL(url).pathname === `/projects/${PROJECT_ONE}`);
  const cssBytes = sum((url) => new URL(url).pathname === "/assets/app.css");
  const entryBytes = sum((url) => /\/assets\/ui\/main-[^/]+\.js$/.test(url));
  const routeBytes = sum((url) => /\/assets\/ui\/ProjectPage-[^/]+\.js$/.test(url));
  const total = documentBytes + cssBytes + entryBytes + routeBytes;

  test.info().annotations.push({
    type: "transfer",
    description: `document=${documentBytes} css=${cssBytes} entry=${entryBytes} route=${routeBytes} total=${total}`,
  });
  process.stdout.write(
    `/projects/:id first load transfer: document=${documentBytes} css=${cssBytes} entry=${entryBytes} route=${routeBytes} total=${total} bytes\n`,
  );

  expect(entryBytes).toBeGreaterThan(0);
  expect(routeBytes).toBeGreaterThan(0);
});
