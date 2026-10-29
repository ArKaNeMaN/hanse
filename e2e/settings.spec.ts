import { expect, test } from "@playwright/test";
import {
  collectPageErrors,
  expectNoPageErrors,
  PROJECT_ONE,
  settle,
  signIn,
} from "./support/helpers.js";

const settingsPaths = [
  "/settings",
  `/projects/${PROJECT_ONE}/settings`,
  `/projects/${PROJECT_ONE}/apps/alpha/settings`,
];

test("renders the global, project, and application settings pages", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page);

  for (const path of settingsPaths) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.locator("#settings-agent")).toBeVisible();
    await expect(page.locator("#setting-llm-model")).toBeVisible();
    await expect(page.locator("#settings-git")).toBeVisible();
  }

  await settle(page);
  expectNoPageErrors(errors);
});

test("saves a setting through the real form and reloads the value", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page);
  await page.goto("/settings");

  await page.locator("#setting-llm-model > summary").click();
  const form = page.locator("#setting-llm-model form[data-settings-form]");
  await form.locator('input[name="value"]').fill("test-provider/test-model-2");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast-region")).toContainText("Settings saved.");

  await page.goto("/settings");
  await page.locator("#setting-llm-model > summary").click();
  await expect(
    page.locator("#setting-llm-model form[data-settings-form] input[name='value']"),
  ).toHaveValue("test-provider/test-model-2");

  await settle(page);
  expectNoPageErrors(errors);
});
