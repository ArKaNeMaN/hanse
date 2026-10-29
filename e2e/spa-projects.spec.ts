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
  breadcrumb: '<span class="crumb">Swapped Projects</span>',
  title: "Projects",
  active: "projects",
  pendingCount: 0,
  sshPendingCount: 0,
};

test("deep links, refreshes, swaps chrome, and restores history", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/projects?q=Project+Two");

  await expect(page).toHaveURL(/\/projects\?q=Project(?:\+|%20)Two$/);
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#ui-fallback")).not.toBeVisible();
  await expect(page.getByRole("link", { name: "E2E Project Two", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "E2E Project One", exact: true })).toHaveCount(0);

  // Only the chrome request is replaced; the projects query keeps its real response.
  await page.route(/\/api\/ui\/chrome\?/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(CHROME_FIXTURE),
    }),
  );

  await page.locator("#project-search").fill("Project One");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/\/projects\?q=Project(?:\+|%20)One$/);
  await expect(page.locator("#breadcrumb-host")).toContainText("Swapped Projects");
  await expect(page).toHaveTitle("Projects - hanse");
  await expect(page.getByRole("link", { name: "E2E Project One", exact: true })).toBeVisible();

  await page.reload();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.getByRole("link", { name: "E2E Project One", exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/projects\?q=Project(?:\+|%20)Two$/);
  await expect(page.getByRole("link", { name: "E2E Project Two", exact: true })).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(/\/projects\?q=Project(?:\+|%20)One$/);
  await expect(page.getByRole("link", { name: "E2E Project One", exact: true })).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("project links cross the SPA boundary with a full document load", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page);

  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/projects/${PROJECT_ONE}` && response.status() === 200,
  );
  await page.getByRole("link", { name: "E2E Project One", exact: true }).click();
  await responsePromise;

  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ONE}$`));
  await expect(page.locator("#hanse-boot")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "E2E Project One" })).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("?legacy=1 serves the legacy projects document", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page);

  const response = await page.goto("/projects?legacy=1");
  expect(response?.status()).toBe(200);
  await expect(page.locator("#hanse-boot")).toHaveCount(0);
  await expect(page.locator("#project-search")).toBeVisible();
  await expect(page.getByRole("link", { name: "E2E Project Two", exact: true })).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("the legacy and empty-allowlist servers still serve the rollback page", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page);

  for (const origin of ["http://127.0.0.1:4311", "http://127.0.0.1:4312"]) {
    const response = await page.goto(`${origin}/projects`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("#hanse-boot")).toHaveCount(0);
    await expect(page.locator("#project-search")).toBeVisible();
    await expect(page.getByRole("link", { name: "E2E Project One", exact: true })).toBeVisible();
  }

  await settle(page);
  expectNoPageErrors(errors);
});

test("reveals the server fallback when the entry module fails", async ({ page }) => {
  await signIn(page);
  await page.route(/\/assets\/ui\/main-[^/]+\.js$/, (route) =>
    route.fulfill({ status: 500, contentType: "text/javascript", body: "" }),
  );

  await page.goto("/projects");

  const fallback = page.locator("#ui-fallback");
  await expect(fallback).toBeVisible({ timeout: 8_000 });
  await expect(fallback).toContainText("The new interface did not load.");
  await expect(fallback.getByRole("link", { name: "Use the classic interface" })).toHaveAttribute(
    "href",
    "?legacy=1",
  );
});

test("mounts without a fallback flash or console errors", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page);

  await page.goto("/projects", { waitUntil: "domcontentloaded" });
  expect(await page.locator("#ui-fallback").isVisible()).toBe(false);

  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#ui-fallback")).toHaveCount(0);

  await settle(page);
  expectNoPageErrors(errors);
});

test("keeps the first load transfer and CLS within budget", async ({ page }) => {
  await signIn(page);

  await page.addInitScript(() => {
    const state: { value: number } = { value: 0 };
    Object.defineProperty(window, "__hanseCls", { value: state, configurable: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
        if (shift.hadRecentInput !== true && typeof shift.value === "number") {
          state.value += shift.value;
        }
      }
    }).observe({ type: "layout-shift", buffered: true });
  });

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

  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await settle(page);
  await page.waitForTimeout(500);

  const entries = [...lengths.entries()];
  const sum = (predicate: (url: string) => boolean): number =>
    entries.filter(([url]) => predicate(url)).reduce((total, [, size]) => total + size, 0);

  const documentBytes = sum((url) => new URL(url).pathname === "/projects");
  const cssBytes = sum((url) => new URL(url).pathname === "/assets/app.css");
  const entryBytes = sum((url) => /\/assets\/ui\/main-[^/]+\.js$/.test(url));
  const routeBytes = sum((url) => /\/assets\/ui\/ProjectsPage-[^/]+\.js$/.test(url));
  const total = documentBytes + cssBytes + entryBytes + routeBytes;

  test.info().annotations.push({
    type: "transfer",
    description: `document=${documentBytes} css=${cssBytes} entry=${entryBytes} route=${routeBytes} total=${total}`,
  });
  process.stdout.write(
    `/projects first load transfer: document=${documentBytes} css=${cssBytes} entry=${entryBytes} route=${routeBytes} total=${total} bytes\n`,
  );

  expect(entryBytes).toBeGreaterThan(0);
  expect(routeBytes).toBeGreaterThan(0);
  expect(total).toBeLessThanOrEqual(204_800);

  const cls = await page.evaluate(() => {
    const state = window as unknown as { __hanseCls?: { value: number } };
    return state.__hanseCls?.value ?? 0;
  });
  test.info().annotations.push({ type: "cls", description: String(cls) });
  process.stdout.write(`/projects CLS: ${cls}\n`);
  expect(cls).toBeLessThanOrEqual(0.1);
});
