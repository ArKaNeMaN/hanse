import { expect, type Page, test } from "@playwright/test";
import {
  collectPageErrors,
  expectNoPageErrors,
  PROJECT_ONE,
  PROJECT_TWO,
  settle,
  signIn,
  upstreamInfo,
} from "./support/helpers.js";

function isSpaProject(): boolean {
  return test.info().project.name === "spa";
}

async function control(page: Page, body: Record<string, unknown>): Promise<void> {
  const port = Number(new URL(page.url()).port);
  const response = await fetch(`${upstreamInfo(port).url}/__control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
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

test("an overview project link opens the project page", async ({ page }) => {
  const errors = collectPageErrors(page);
  const spa = isSpaProject();
  await signIn(page, "/");

  const responsePromise = spa
    ? undefined
    : page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/projects/${PROJECT_ONE}` &&
          response.status() === 200,
      );
  await page
    .locator('section[aria-labelledby="project-ledger-title"]')
    .getByRole("link", { name: "E2E Project One", exact: true })
    .click();
  if (responsePromise !== undefined) {
    await responsePromise;
  }

  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ONE}$`));
  // SPA client navigation keeps the document and its boot marker.
  await expect(page.locator("#hanse-boot")).toHaveCount(spa ? 1 : 0);
  await expect(page.getByRole("heading", { name: "E2E Project One" })).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("SPA shows the agent processes block for affected applications", async ({ page }) => {
  test.skip(!isSpaProject(), "the process block is a Vue surface");
  const errors = collectPageErrors(page);
  const beta = `${PROJECT_ONE}:beta`;
  const gamma = `${PROJECT_TWO}:gamma`;
  await signIn(page, "/");
  try {
    await control(page, {
      event: {
        processSnapshot: {
          appId: beta,
          state: "starting",
          phase: "waiting_ready",
          attemptId: "e2e-overview-start",
          startedAt: new Date(Date.now() - 5_000).toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    });
    await control(page, {
      event: {
        processSnapshot: {
          appId: gamma,
          state: "error",
          phase: "failed",
          attemptId: "e2e-overview-error",
          errorCode: "readiness_timeout",
          errorMessage: "The fixture overview start failed.",
          updatedAt: new Date().toISOString(),
        },
      },
    });

    await page.goto("/");
    const block = page.locator("#agent-processes");
    await expect(block).toBeVisible({ timeout: 15_000 });
    await expect(block.locator("#process-count-starting")).toHaveText("1");
    await expect(block.locator("#process-count-stopping")).toHaveText("0");
    await expect(block.locator("#process-count-error")).toHaveText("1");
    await expect(block).toContainText("beta");
    await expect(block).toContainText("gamma");
    await expect(block).not.toContainText("master");
    await page.waitForTimeout(400);
    expectNoPageErrors(errors);
  } finally {
    await control(page, {
      event: { processSnapshot: { appId: beta, state: "stopped", phase: "stopped" } },
    });
    await control(page, {
      event: { processSnapshot: { appId: gamma, state: "stopped", phase: "stopped" } },
    });
  }
});
