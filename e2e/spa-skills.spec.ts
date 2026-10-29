import { expect, test } from "@playwright/test";
import {
  collectPageErrors,
  expectNoPageErrors,
  PROJECT_ONE,
  settle,
  signIn,
} from "./support/helpers.js";
import { E2E_HTTPS_TOKEN, E2E_PROVIDER_SECRET } from "./support/seed.js";

const PROJECT_SKILLS = `/projects/${PROJECT_ONE}/skills`;
const APP_SKILLS = `/projects/${PROJECT_ONE}/apps/alpha/skills`;
const NEW_SKILL = `/skills/new?scope=project&project=${PROJECT_ONE}`;

test("deep links, refresh, and history stay in one SPA document", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/skills");

  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#ui-fallback")).not.toBeVisible();

  const detailHref = await page
    .locator("[data-skill-inventory] tr a.mono")
    .first()
    .getAttribute("href");
  expect(detailHref).not.toBeNull();
  await page.goto(detailHref ?? "/skills");
  await expect(page).toHaveURL(/\/skills\/\d+/);
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#skill-details")).toBeVisible();

  await page.reload();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#skill-details")).toBeVisible();

  await page.goto(NEW_SKILL);
  await expect(page.getByRole("heading", { name: "New skill" })).toBeVisible();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);

  await page.goBack();
  await expect(page).toHaveURL(/\/skills\/\d+/);
  await expect(page.locator("#skill-details")).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(/\/skills\/new/);
  await expect(page.getByRole("heading", { name: "New skill" })).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("navigates between global, project, and application skills without a reload", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, APP_SKILLS);
  await page.evaluate(() => {
    (window as unknown as { __hanseSpaMarker?: number }).__hanseSpaMarker = 1;
  });

  await page.locator(".settings-nav a", { hasText: "Global" }).click();
  await expect(page).toHaveURL(/\/skills$/);
  await expect(page.locator("#hanse-boot")).toHaveCount(1);

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${APP_SKILLS}$`));

  await page.locator(".settings-nav a", { hasText: "Project" }).click();
  await expect(page).toHaveURL(new RegExp(`${PROJECT_SKILLS}$`));
  await expect(page.locator("#sidebar-nav")).toHaveAttribute("data-nav-id", "skills");
  await expect(page.locator("#breadcrumb-host")).toContainText("Skills");
  await expect(page).toHaveTitle("Skills - hanse");

  await page.locator("[data-skill-inventory] tr a.mono").first().click();
  await expect(page).toHaveURL(/\/skills\/\d+/);
  await expect(page.locator("#skill-details")).toBeVisible();

  expect(
    await page.evaluate(
      () => (window as unknown as { __hanseSpaMarker?: number }).__hanseSpaMarker,
    ),
  ).toBe(1);

  await settle(page);
  expectNoPageErrors(errors);
});

test("?legacy=1 and the rollback servers serve the legacy skills pages", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/skills");

  const legacy = await page.goto("/skills?legacy=1");
  expect(legacy?.status()).toBe(200);
  await expect(page.locator("#hanse-boot")).toHaveCount(0);
  await expect(page.locator("[data-skill-inventory]")).toBeVisible();

  for (const origin of ["http://127.0.0.1:4311", "http://127.0.0.1:4312"]) {
    const response = await page.goto(`${origin}/skills`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("#hanse-boot")).toHaveCount(0);
    await expect(page.locator("[data-skill-inventory]")).toBeVisible();
  }

  await settle(page);
  expectNoPageErrors(errors);
});

test("mounts without a fallback flash, console errors, or secret text", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/skills");

  await page.goto("/skills", { waitUntil: "domcontentloaded" });
  expect(await page.locator("#ui-fallback").isVisible()).toBe(false);

  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#ui-fallback")).toHaveCount(0);
  await expect(page.locator("[data-skill-inventory]")).toBeVisible();

  const content = await page.content();
  expect(content).not.toContain(E2E_PROVIDER_SECRET);
  expect(content).not.toContain(E2E_HTTPS_TOKEN);

  await settle(page);
  expectNoPageErrors(errors);
});
