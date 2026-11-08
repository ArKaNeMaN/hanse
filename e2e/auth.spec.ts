import { expect, test } from "@playwright/test";
import { collectPageErrors, expectNoPageErrors, settle, signIn } from "./support/helpers.js";

test("redirects an unauthenticated page request to login", async ({ page }) => {
  const errors = collectPageErrors(page);
  const spa = test.info().project.name === "spa";

  await page.goto("/projects");

  await expect(page).toHaveURL(/\/login\?next=%2Fprojects$/);
  await expect(page.getByRole("heading", { name: "Operator sign-in" })).toBeVisible();
  if (spa) await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await settle(page);
  expectNoPageErrors(errors);
});

test("signs in with a cookie and signs out", async ({ page, context }) => {
  const errors = collectPageErrors(page);

  await signIn(page);
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();

  const cookie = (await context.cookies()).find((entry) => entry.name === "hanse_token");
  expect(cookie?.value).toBe("test-operator-token");
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Strict");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/projects");
  await expect(page).toHaveURL(/\/login\?next=%2Fprojects$/);
  await settle(page);
  expectNoPageErrors(errors);
});

test("serves the legacy login form behind ?legacy=1", async ({ page }) => {
  const errors = collectPageErrors(page);

  await page.goto("/login?legacy=1");
  await expect(page.getByRole("heading", { name: "Operator sign-in" })).toBeVisible();
  await expect(page.locator("#hanse-boot")).toHaveCount(0);

  await settle(page);
  expectNoPageErrors(errors);
});
