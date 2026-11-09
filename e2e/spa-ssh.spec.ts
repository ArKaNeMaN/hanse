import { expect, type Page, test } from "@playwright/test";
import {
  collectPageErrors,
  expectNoPageErrors,
  PROJECT_ONE,
  settle,
  signIn,
} from "./support/helpers.js";

async function expectSingleLineClientFingerprints(page: Page): Promise<void> {
  const clientFingerprints = page.locator(
    '.ssh-host .ssh-host__fingerprint[title="SHA256:e2e-fixture-fingerprint"]',
  );
  await expect(clientFingerprints).toHaveCount(2);
  for (let index = 0; index < 2; index += 1) {
    const fingerprint = clientFingerprints.nth(index);
    await expect(fingerprint).toBeVisible();
    await expect(fingerprint).toHaveCSS("white-space", "nowrap");
    await expect(fingerprint).toHaveCSS("text-overflow", "ellipsis");
    expect(await fingerprint.textContent()).toContain("…");
    const cardBox = await page.locator(".ssh-host").nth(index).boundingBox();
    const fingerprintBox = await fingerprint.boundingBox();
    expect(fingerprintBox?.width ?? 0).toBeLessThanOrEqual(cardBox?.width ?? 0);
  }
}

test("deep links, target queries, refreshes, and history stay in the SPA document", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, `/ssh?target=${PROJECT_ONE}:alpha`);

  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#ui-fallback")).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "SSH hosts" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/ssh\\?target=${PROJECT_ONE}(?::|%3A)alpha$`));

  await expectSingleLineClientFingerprints(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#main").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.locator("#ssh-hosts").scrollIntoViewIfNeeded();
  await expectSingleLineClientFingerprints(page);
  const mobileOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(mobileOverflow).toBe(false);

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

test("section nav marks the current section and the header keeps counts in the strip", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/ssh");

  await expect(page.locator(".page-header .page-meta")).toHaveCount(0);
  await expect(page.locator(".ssh-watch .watch")).toHaveCount(4);

  const sections = page.locator(".ssh-nav .settings-nav__sections");
  await expect(sections.locator('a[aria-current="page"]')).toHaveText("Hosts");

  await sections.getByRole("link", { name: "Access", exact: true }).click();
  await expect(sections.locator('a[aria-current="page"]')).toHaveText("Access");
  await expect(page.locator("#ssh-access")).toBeInViewport();

  await page.locator("#main").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(sections.locator('a[aria-current="page"]')).toHaveText("Audit");

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflow).toBe(false);
  }

  await settle(page);
  expectNoPageErrors(errors);
});

test("swaps chrome, title, and active nav on client navigation and keeps them for a scoped target", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/");

  await expect(page.locator("#breadcrumb-host")).toContainText("Overview");
  await expect(page).toHaveTitle("Fleet overview - hanse");

  await page.locator('#sidebar-nav a[data-nav-id="ssh"]').click();
  await expect(page).toHaveURL(/\/ssh$/);
  await expect(page.getByRole("heading", { name: "SSH hosts" })).toBeVisible();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#breadcrumb-host")).toContainText("SSH");
  await expect(page.locator("#breadcrumb-host")).not.toContainText("Overview");
  await expect(page.locator("#breadcrumb-host")).toHaveAttribute("data-nav-id", "ssh");
  await expect(page.locator("#sidebar-nav")).toHaveAttribute("data-nav-id", "ssh");
  await expect(page).toHaveTitle("SSH - hanse");

  await page.locator("#ssh-scope").selectOption(`${PROJECT_ONE}:alpha`);
  await page.getByRole("button", { name: "Apply" }).click();

  await expect(page).toHaveURL(new RegExp(`/ssh\\?target=${PROJECT_ONE}(?::|%3A)alpha$`));
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#breadcrumb-host")).toContainText("SSH");
  await expect(page.locator("#breadcrumb-host")).toHaveAttribute("data-nav-id", "ssh");
  await expect(page.locator("#sidebar-nav")).toHaveAttribute("data-nav-id", "ssh");
  await expect(page).toHaveTitle("SSH - hanse");
  await expect(page.locator("#route-announcer")).toHaveText("SSH");

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
