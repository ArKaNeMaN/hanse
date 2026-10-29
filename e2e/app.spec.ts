import { expect, test } from "@playwright/test";
import {
  collectPageErrors,
  expectNoPageErrors,
  PROJECT_ONE,
  settle,
  signIn,
} from "./support/helpers.js";

test("renders the application runtime strip and git/image panels", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page);

  const response = await page.goto(`/projects/${PROJECT_ONE}/apps/alpha`);
  expect(response?.status()).toBe(200);

  await expect(page.locator("#app-state")).toBeVisible();
  await expect(page.locator("#runtime-state")).toContainText("Running");
  await expect(page.locator("#git-panel")).toBeAttached();
  await expect(page.getByRole("heading", { name: "Repository" })).toBeVisible();
  await expect(page.locator("#image-panel")).toBeVisible();
  await expect(page.locator("#ssh-panel")).toBeVisible();

  await expect(page.locator("#git-refreshed")).toContainText("Refreshed", { timeout: 15_000 });
  await settle(page);
  expectNoPageErrors(errors);
});
