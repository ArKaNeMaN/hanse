import { expect, test } from "@playwright/test";
import { collectPageErrors, expectNoPageErrors, settle, signIn } from "./support/helpers.js";

function isSpaProject(): boolean {
  return test.info().project.name === "spa";
}

test("lists the seeded projects and filters the ledger", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page);

  expect(await page.locator("#hanse-boot").count()).toBe(isSpaProject() ? 1 : 0);

  await expect(page.getByRole("link", { name: "E2E Project One", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "E2E Project Two", exact: true })).toBeVisible();

  await page.locator("#project-search").fill("Project Two");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/\/projects\?q=Project(?:\+|%20)Two$/);
  await expect(page.getByRole("link", { name: "E2E Project Two", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "E2E Project One", exact: true })).toHaveCount(0);

  await page.locator("#project-search").fill("no-such-project-xyz");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("No matching projects")).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("creates a project from the form and lands on its notice", async ({ page }) => {
  const errors = collectPageErrors(page);
  const spa = isSpaProject();
  await signIn(page);

  const name = `E2E Created ${Date.now()}`;
  await page.getByRole("button", { name: "New project" }).click();
  const dialog = page.locator("#new-project");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Project name (required)").fill(name);

  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/projects" &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Create project" }).click();
  const response = await responsePromise;

  if (spa) {
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
  } else {
    expect(response.status()).toBe(303);
  }

  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\?notice=/);
  await expect(page.locator("#toast-region")).toContainText("Project created.");

  await page.goto("/projects");
  await expect(page.getByRole("link", { name, exact: true })).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("serves the legacy document behind ?legacy=1", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page);

  await page.goto("/projects?legacy=1");
  await expect(page.locator("#hanse-boot")).toHaveCount(0);
  await expect(page.locator("#project-search")).toBeVisible();
  await expect(page.getByRole("link", { name: "E2E Project One", exact: true })).toBeVisible();
  await expect(page.locator("#new-project")).toBeAttached();

  await settle(page);
  expectNoPageErrors(errors);
});
