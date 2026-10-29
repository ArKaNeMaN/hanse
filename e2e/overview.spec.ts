import { expect, test } from "@playwright/test";
import {
  collectPageErrors,
  expectNoPageErrors,
  PROJECT_ONE,
  settle,
  signIn,
} from "./support/helpers.js";

function isSpaProject(): boolean {
  return test.info().project.name === "spa";
}

test("renders the fleet overview with counts, ledger, handoffs, waiting, and runtime", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/");

  expect(await page.locator("#hanse-boot").count()).toBe(isSpaProject() ? 1 : 0);
  await expect(page.getByRole("heading", { name: "Fleet overview" })).toBeVisible();
  await expect(page.getByText("Current state of every project")).toBeVisible();

  const watchValues = await page.locator(".watch__value").allTextContents();
  expect(watchValues).toEqual(["2", "3", "1", "1"]);
  expect(await page.locator(".watch__label").allTextContents()).toEqual([
    "Projects",
    "Applications",
    "Agents running",
    "Handoffs waiting",
  ]);

  const ledger = page.locator('section[aria-labelledby="project-ledger-title"]');
  await expect(ledger.locator("tbody tr")).toHaveCount(2);
  await expect(ledger.getByRole("link", { name: "E2E Project One", exact: true })).toBeVisible();
  await expect(ledger.getByRole("link", { name: "E2E Project Two", exact: true })).toBeVisible();
  await expect(ledger).toContainText("project-one");
  await expect(ledger).toContainText("project-two");

  const recent = page.locator('section[aria-labelledby="recent-handoffs-title"]');
  await expect(recent).toContainText("E2E handoff summary");
  await expect(recent).toContainText("alpha");
  await expect(recent).toContainText("beta");
  await expect(recent).toContainText("Awaiting approval");

  const waiting = page.locator('section[aria-labelledby="waiting-title"]');
  await expect(waiting.locator(".route-card")).toHaveCount(1);
  await expect(waiting.locator(".route-card")).toContainText("E2E handoff summary");
  await expect(waiting.getByRole("link", { name: "Review" })).toHaveAttribute(
    "href",
    "/handoffs?filter=waiting",
  );

  const runtime = page.locator('section[aria-labelledby="runtime-title"]');
  await expect(runtime.locator(".summary-row", { hasText: "Starting" })).toContainText("0");
  await expect(runtime.locator(".summary-row", { hasText: "Running" })).toContainText("1");
  await expect(runtime.locator(".summary-row", { hasText: "Stopped" })).toContainText("2");
  await expect(runtime.locator(".summary-row", { hasText: "Error" })).toContainText("0");

  await settle(page);
  expectNoPageErrors(errors);
});

test("creates a project from the overview dialog and lands on its notice", async ({ page }) => {
  const errors = collectPageErrors(page);
  const spa = isSpaProject();
  await signIn(page, "/");

  const name = `E2E Overview ${Date.now()}`;
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

  await page.goto("/");
  await expect(page.getByRole("link", { name, exact: true })).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("an overview project link crosses the boundary to the legacy project page", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, "/");

  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/projects/${PROJECT_ONE}` && response.status() === 200,
  );
  await page
    .locator('section[aria-labelledby="project-ledger-title"]')
    .getByRole("link", { name: "E2E Project One", exact: true })
    .click();
  await responsePromise;

  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ONE}$`));
  await expect(page.locator("#hanse-boot")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "E2E Project One" })).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});
