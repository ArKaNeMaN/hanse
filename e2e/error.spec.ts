import { expect, test } from "@playwright/test";
import { collectPageErrors, expectNoPageErrors, settle, signIn } from "./support/helpers.js";

test("returns the Vue 404 for an unknown project and path", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page);

  for (const path of ["/projects/does-not-exist", "/nope"]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(404);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await expect(page.getByText("Nothing is moored here")).toBeVisible();
    await expect(page.locator("#hanse-boot")).toHaveCount(1);
  }

  await settle(page);
  expectNoPageErrors(errors.filter((entry) => !entry.includes("status of 404")));
});
