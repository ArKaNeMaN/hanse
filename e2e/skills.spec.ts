import { expect, test } from "@playwright/test";
import {
  collectPageErrors,
  expectNoPageErrors,
  PROJECT_ONE,
  settle,
  signIn,
} from "./support/helpers.js";

test("renders the skill inventory and workspace pages", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page);

  const inventory = await page.goto("/skills");
  expect(inventory?.status()).toBe(200);
  await expect(page.locator("[data-skill-inventory]")).toBeVisible();
  await expect(
    page.locator('[data-skill-inventory] tr[data-skill-name="e2e-global-skill"]'),
  ).toBeVisible();

  const projectInventory = await page.goto(`/projects/${PROJECT_ONE}/skills`);
  expect(projectInventory?.status()).toBe(200);
  await expect(
    page.locator('[data-skill-inventory] tr[data-skill-name="e2e-project-skill"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-skill-inventory] tr[data-skill-name="e2e-global-skill"]'),
  ).toBeVisible();

  await page.goto("/skills");
  await page.getByRole("link", { name: "e2e-global-skill" }).first().click();
  await expect(page).toHaveURL(/\/skills\/\d+/);
  await expect(page.locator("#skill-details")).toBeVisible();
  await expect(page.getByText("SKILL.md").first()).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});
