import { expect, test } from "@playwright/test";
import {
  collectPageErrors,
  expectNoPageErrors,
  PROJECT_ONE,
  PROJECT_TWO,
  settle,
  signIn,
} from "./support/helpers.js";

test("deep links, refreshes, swaps chrome, and restores history", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, `/projects/${PROJECT_ONE}`);

  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#ui-fallback")).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "E2E Project One" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Applications" })).toBeVisible();

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Fleet overview" })).toBeVisible();
  await expect(page.locator("#breadcrumb-host")).toContainText("Overview");
  await expect(page).toHaveTitle("Fleet overview - hanse");
  await page.getByRole("link", { name: "E2E Project One", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ONE}$`));
  await expect(page.getByRole("heading", { name: "E2E Project One" })).toBeVisible();
  await expect(page.locator("#breadcrumb-host")).toContainText("E2E Project One");
  await expect(page.locator("#breadcrumb-host")).toContainText("Projects");
  await expect(page.locator("#breadcrumb-host")).toHaveAttribute("data-nav-id", "project");
  await expect(page.locator("#sidebar-nav")).toHaveAttribute("data-nav-id", "project");
  await expect(page).toHaveTitle("E2E Project One - hanse");

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

test("renders the project dialogs, manifest, and application links", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, `/projects/${PROJECT_ONE}`);

  await expect(page.locator("#add-app")).toBeAttached();
  await expect(page.locator("#new-handoff")).toBeAttached();
  await expect(page.getByText(".hanse/project.yaml")).toBeVisible();
  await expect(page.getByRole("link", { name: "alpha", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "beta", exact: true })).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("shows outbound grants on the source and read-only inbound grants on the target", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, `/projects/${PROJECT_ONE}`);

  await expect(page.getByRole("heading", { name: "Cross-project grants" })).toBeVisible();
  const grants = page.locator('section[aria-labelledby="handoff-grants-title"]');
  const outbound = grants.locator("table").first();
  const outboundRow = outbound.locator("tbody tr", { hasText: "gamma" });
  await expect(outboundRow).toHaveCount(1);
  await expect(outboundRow).toContainText("alpha");
  await expect(outboundRow).toContainText("E2E Project Two");
  await expect(outboundRow).toContainText("auto");

  const handoffs = page.locator('section[aria-labelledby="project-handoffs-title"]');
  const crossRow = handoffs.locator("tbody tr", { hasText: "E2E cross-project handoff" });
  await expect(crossRow).toHaveCount(1);
  await expect(crossRow.locator("time")).toHaveAttribute("datetime", "2021-01-01T00:00:00.000Z");

  await page.goto(`/projects/${PROJECT_TWO}`);
  await expect(page.getByRole("heading", { name: "Cross-project grants" })).toBeVisible();
  const targetGrants = page.locator('section[aria-labelledby="handoff-grants-title"]');
  await expect(targetGrants).toContainText("Read-only.");
  const inboundRow = targetGrants.locator("table tbody tr", { hasText: "gamma" });
  await expect(inboundRow).toHaveCount(1);
  await expect(inboundRow).toContainText("E2E Project One");
  await expect(inboundRow).toContainText("alpha");

  await settle(page);
  expectNoPageErrors(errors);
});
