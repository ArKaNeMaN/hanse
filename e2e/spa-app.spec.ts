import { expect, test } from "@playwright/test";
import {
  collectPageErrors,
  expectNoPageErrors,
  PROJECT_ONE,
  settle,
  signIn,
} from "./support/helpers.js";

const APP_PATH = `/projects/${PROJECT_ONE}/apps/alpha`;

async function openApp(page: Parameters<typeof signIn>[0]): Promise<void> {
  await signIn(page, APP_PATH);
  await expect(page.getByRole("heading", { name: "alpha", exact: true })).toBeVisible();
}

test("deep links, refreshes, and renders the read-only runtime, image, git, and SSH panels", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await openApp(page);

  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#ui-fallback")).toHaveCount(0);

  await expect(page.locator("#runtime-state")).toContainText("Running");
  await expect(page.locator("#settings-state")).toContainText("Restart required");
  await expect(page.locator("#app-restart")).toBeVisible();

  await expect(page.locator("#image-panel")).toBeVisible();
  await expect(page.locator("#image-ref")).toHaveText("Default agent image");

  await expect(page.getByRole("heading", { name: "Repository" })).toBeVisible();
  await expect(page.locator("#git-refreshed")).toContainText("Refreshed", { timeout: 15_000 });
  await expect(page.locator("#git-branch")).toContainText("main");
  await expect(page.locator("#git-upstream")).toContainText("No upstream");
  await expect(page.locator("#repository-card")).toContainText("Clean");
  await expect(page.locator("#git-clean")).toContainText("Working tree clean");
  await expect(page.locator("#last-commit-card")).toContainText("fixture commit");

  await expect(page.locator("#ssh-panel-title")).toHaveText("SSH access");
  await expect(page.locator("#ssh-panel")).toContainText("1 allowed host");
  await expect(page.locator("#ssh-panel")).toContainText("2 pending approvals");
  await expect(page.locator("#ssh-grants")).toContainText("test-host");
  await expect(page.locator("#ssh-grants")).toContainText("Active");
  await expect(page.locator("#ssh-approvals")).toContainText("echo approve e2e");
  await expect(page.locator("#ssh-audit")).toHaveCount(0);
  await expect(page.locator("#ssh-panel")).toContainText("No audit entries.");

  for (const href of [
    `/chat?app=alpha&project=${PROJECT_ONE}`,
    `/terminal?app=alpha&project=${PROJECT_ONE}`,
    `/projects/${PROJECT_ONE}/apps/alpha/settings`,
    `/projects/${PROJECT_ONE}/apps/alpha/skills`,
    `/ssh?project=${PROJECT_ONE}&app=alpha`,
  ]) {
    await expect(page.locator(`a[href="${href}"]`).first()).toBeAttached();
  }
  await expect(page.locator('a[href^="/ide/"]').first()).toBeAttached();

  // The SPA document must not load the legacy island scripts.
  await expect(page.locator('script[src*="git.js"]')).toHaveCount(0);
  await expect(page.locator('script[src*="images.js"]')).toHaveCount(0);
  await expect(page.locator('script[src*="ssh.js"]')).toHaveCount(0);

  await page.reload();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "alpha", exact: true })).toBeVisible();
  await expect(page.locator("#image-panel")).toBeVisible();

  await settle(page);
  expectNoPageErrors(errors);
});

test("restarts the agent, refreshes the props, and clears the restart-required state", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await openApp(page);

  await expect(page.locator("#settings-state")).toContainText("Restart required");
  await page.locator("#app-restart").click();
  await expect(page.locator("#app-restart-dialog")).toBeVisible();
  await expect(page.locator("#app-restart-dialog")).toContainText("Restart alpha?");
  await page.locator("#app-restart-dialog").getByRole("button", { name: "Restart agent" }).click();

  await expect(page.getByText("Agent restarted.")).toBeVisible();
  await expect(page.locator("#app-restart-dialog")).not.toHaveAttribute("open");
  await expect(page.locator("#settings-state")).toContainText("Applied", { timeout: 15_000 });

  await settle(page);
  expectNoPageErrors(errors);
});

test("surfaces a restart failure without breaking the page", async ({ page }) => {
  // The intentional 503 is surfaced by the browser as one network console message; this test
  // asserts the app-level error handling, while the success and read tests assert no console or
  // page errors on the normal path.
  await openApp(page);

  await page.route(/\/api\/apps\/alpha\/restart\?/, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "restart unavailable", code: "runtime_unavailable" }),
    }),
  );

  await page.locator("#app-restart").click();
  await page.locator("#app-restart-dialog").getByRole("button", { name: "Restart agent" }).click();

  await expect(page.getByText("restart unavailable")).toBeVisible();
  await expect(page.getByRole("heading", { name: "alpha", exact: true })).toBeVisible();
});

test("?legacy=1 serves the legacy application document with its island scripts", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, APP_PATH);

  const response = await page.goto(`${APP_PATH}?legacy=1`);
  expect(response?.status()).toBe(200);
  await expect(page.locator("#hanse-boot")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "alpha", exact: true })).toBeVisible();
  await expect(page.locator("#app-state")).toBeVisible();
  await expect(page.locator("#git-panel")).toBeAttached();
  await expect(page.locator('script[src="/assets/git.js"]')).toHaveCount(1);
  await expect(page.locator('script[src="/assets/images.js"]')).toHaveCount(1);

  await settle(page);
  expectNoPageErrors(errors);
});

test("the legacy and empty-allowlist servers still serve the application page", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await signIn(page, APP_PATH);

  for (const origin of ["http://127.0.0.1:4311", "http://127.0.0.1:4312"]) {
    const response = await page.goto(`${origin}${APP_PATH}`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("#hanse-boot")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "alpha", exact: true })).toBeVisible();
    await expect(page.locator("#git-panel")).toBeAttached();
  }

  await settle(page);
  expectNoPageErrors(errors);
});

test("mounts without a fallback flash or console errors", async ({ page }) => {
  const errors = collectPageErrors(page);
  await signIn(page, APP_PATH);

  await page.goto(APP_PATH, { waitUntil: "domcontentloaded" });
  expect(await page.locator("#ui-fallback").isVisible()).toBe(false);

  await expect(page.getByRole("heading", { name: "alpha", exact: true })).toBeVisible();
  await expect(page.locator("#hanse-boot")).toHaveCount(1);
  await expect(page.locator("#ui-fallback")).toHaveCount(0);

  await settle(page);
  expectNoPageErrors(errors);
});
