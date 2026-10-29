import { expect, test } from "@playwright/test";
import {
  collectPageErrors,
  expectNoPageErrors,
  PROJECT_ONE,
  settle,
  signIn,
} from "./support/helpers.js";

test("renders hosts, the scoped grant, and audit sections", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page);

  const unscoped = await page.goto("/ssh");
  expect(unscoped?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "SSH hosts" })).toBeVisible();
  await expect(page.getByText("test-host").first()).toBeVisible();

  await page.goto(`/ssh?project=${PROJECT_ONE}&app=alpha`);
  await expect(page.locator("#ssh-access")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Audit" })).toBeVisible();
  await expect(page.getByText("test-operator").first()).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});
