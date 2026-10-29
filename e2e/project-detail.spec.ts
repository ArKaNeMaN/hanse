import { expect, test } from "@playwright/test";
import {
  collectPageErrors,
  expectNoPageErrors,
  PROJECT_ONE,
  settle,
  signIn,
} from "./support/helpers.js";

test("renders the project detail with apps, dialogs, and the manifest", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page);

  const response = await page.goto(`/projects/${PROJECT_ONE}`);
  expect(response?.status()).toBe(200);

  await expect(page.getByRole("heading", { name: "E2E Project One" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Applications" })).toBeVisible();
  await expect(page.locator("#add-app")).toBeAttached();
  await expect(page.locator("#new-handoff")).toBeAttached();
  await expect(page.getByText(".hanse/project.yaml")).toBeVisible();
  await expect(page.getByRole("link", { name: "alpha", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "beta", exact: true })).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});
