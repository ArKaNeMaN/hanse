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

async function control(page: Page, body: Record<string, unknown>): Promise<void> {
  const port = Number(new URL(page.url()).port);
  const response = await fetch(`${upstreamInfo(port).url}/__control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
}

test("renders the application runtime strip and git/image panels", async ({ page }) => {
  const errors = collectPageErrors(page);
  const spa = test.info().project.name === "spa";
  await signIn(page);

  const response = await page.goto(`/projects/${PROJECT_ONE}/apps/alpha`);
  expect(response?.status()).toBe(200);

  await expect(page.locator("#app-state")).toBeVisible();
  await expect(page.locator("#runtime-state")).toContainText("Running");
  if (spa) {
    for (const group of ["git", "image", "ssh"] as const) {
      await page.locator(`#group-${group}-toggle`).click();
      await expect(page.locator(`#group-${group}-body`)).toBeVisible();
    }
  }
  await expect(page.locator("#git-panel")).toBeAttached();
  await expect(page.getByRole("heading", { name: "Repository" })).toBeVisible();
  await expect(page.locator("#image-panel")).toBeVisible();
  await expect(page.locator("#ssh-panel")).toBeVisible();

  await expect(page.locator("#git-refreshed")).toContainText("Refreshed", { timeout: 15_000 });
  await settle(page);
  expectNoPageErrors(errors);
});

test("SPA shows the persisted process error and history on the application page", async ({
  page,
}) => {
  test.skip(test.info().project.name !== "spa", "process detail is a Vue surface");
  const errors = collectPageErrors(page);
  const appId = `${PROJECT_TWO}:gamma`;
  await signIn(page, "/");
  try {
    await control(page, {
      event: {
        processSnapshot: {
          appId,
          state: "error",
          phase: "failed",
          attemptId: "e2e-app-error",
          errorCode: "readiness_timeout",
          errorMessage: "The fixture application start failed.",
          updatedAt: new Date().toISOString(),
        },
      },
    });

    await page.goto(`/projects/${PROJECT_TWO}/apps/gamma`);
    await expect(page.locator("#process-error")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#process-error")).toContainText(
      "The fixture application start failed.",
    );
    const history = page.locator("#process-history");
    await expect(history).toBeAttached();
    await history.locator("summary").click();
    await expect(history).toContainText("No process events recorded.");
    await page.waitForTimeout(400);
    expectNoPageErrors(errors);
  } finally {
    await control(page, {
      event: { processSnapshot: { appId, state: "stopped", phase: "stopped" } },
    });
  }
});
