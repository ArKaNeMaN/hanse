import { expect, test } from "@playwright/test";
import { collectPageErrors, expectNoPageErrors, settle, signIn } from "./support/helpers.js";

test("returns the styled 404 for an unknown project", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page);

  const response = await page.goto("/projects/does-not-exist");
  expect(response?.status()).toBe(404);
  await expect(page.getByText("Page not found")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open overview" })).toBeVisible();

  await settle(page);
  // The styled 404 page is the expected document response; ignore its resource log only.
  expectNoPageErrors(errors.filter((entry) => !entry.includes("status of 404")));
});
