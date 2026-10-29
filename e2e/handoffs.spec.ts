import { expect, test } from "@playwright/test";
import { collectPageErrors, expectNoPageErrors, settle, signIn } from "./support/helpers.js";

test("renders the handoff inbox and filters waiting rows", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page);

  const response = await page.goto("/handoffs");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Handoffs", exact: true })).toBeVisible();
  await expect(page.getByText("E2E handoff summary").first()).toBeVisible();

  await page
    .getByRole("link", { name: /Waiting/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/handoffs\?filter=waiting$/);
  await expect(page.getByText("Waiting for approval")).toBeVisible();
  await expect(page.getByText("E2E handoff summary").first()).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});
