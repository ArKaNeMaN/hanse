import { expect, test } from "@playwright/test";
import {
  collectPageErrors,
  expectNoPageErrors,
  PROJECT_ONE,
  PROJECT_TWO,
  prepareGitState,
  settle,
  signIn,
} from "./support/helpers.js";

const APP_PATH = `/projects/${PROJECT_ONE}/apps/alpha`;
const BETA_PATH = `/projects/${PROJECT_ONE}/apps/beta`;
const GAMMA_PATH = `/projects/${PROJECT_TWO}/apps/gamma`;

function toast(page: Parameters<typeof signIn>[0], text: string) {
  return page.locator("#toast-region .toast", { hasText: text });
}

async function openApp(page: Parameters<typeof signIn>[0]): Promise<void> {
  await signIn(page, APP_PATH);
  await expect(page.getByRole("heading", { name: "alpha", exact: true })).toBeVisible();
}

test("deep links, refreshes, and renders the read-only runtime, image, git, and SSH panels", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  prepareGitState(PROJECT_ONE, "alpha", "clean");
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
  await expect(page.locator("#git-upstream")).toContainText("origin/main");
  await expect(page.locator("#repository-card")).toContainText("Clean");
  await expect(page.locator("#git-clean")).toContainText("Working tree clean");
  await expect(page.locator("#last-commit-card")).toContainText("fixture commit");
  await expect(page.locator("#remotes-card")).toContainText("origin");
  await expect(page.locator("#git-fetch")).toBeEnabled();
  await expect(page.locator("#git-update")).toBeEnabled();
  await expect(page.locator("#git-push")).toBeEnabled();

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

test("renders clean, dirty, detached, and conflicted git states", async ({ page }) => {
  const errors = collectPageErrors(page);
  prepareGitState(PROJECT_ONE, "alpha", "clean");
  await openApp(page);
  await expect(page.locator("#repository-card").getByText("Clean", { exact: true })).toBeVisible();
  await expect(page.locator("#remotes-card")).toContainText("origin");

  prepareGitState(PROJECT_ONE, "beta", "dirty");
  await page.goto(BETA_PATH);
  await expect(page.getByRole("heading", { name: "beta", exact: true })).toBeVisible();
  await expect(page.locator("#repository-card")).toContainText("Changes");
  await expect(page.locator("#git-change-counts")).toContainText("Staged 1");
  await expect(page.locator("#git-change-counts")).toContainText("Unstaged 1");
  await expect(page.locator("#git-change-counts")).toContainText("Untracked 1");
  await expect(page.locator("#git-changes-body")).toContainText("staged.txt");
  await expect(page.locator("#git-changes-body")).toContainText("untracked.txt");
  await expect(page.locator("#git-commit-form")).toBeVisible();

  prepareGitState(PROJECT_TWO, "gamma", "detached");
  await page.goto(GAMMA_PATH);
  await expect(page.getByRole("heading", { name: "gamma", exact: true })).toBeVisible();
  await expect(page.locator("#git-branch")).toContainText("Detached HEAD");
  await expect(page.locator("#repository-card")).toContainText("Detached");
  await expect(page.locator("#git-branch-select")).toContainText("Choose a branch");
  await expect(page.locator("#git-update")).toBeDisabled();
  await expect(page.locator("#git-push")).toBeDisabled();
  await expect(page.locator("#git-commit")).toHaveCount(0);

  prepareGitState(PROJECT_ONE, "beta", "conflicted");
  await page.goto(BETA_PATH);
  await expect(page.locator("#repository-card")).toContainText("Conflicts");
  await expect(page.locator("#git-change-counts")).toContainText("Conflicted 1");
  await expect(page.locator("#git-commit")).toBeDisabled();
  await expect(page.locator("#git-switch")).toBeDisabled();
  await expect(page.locator("#git-commit-hint")).toContainText("Resolve conflicts");

  await settle(page);
  expectNoPageErrors(errors);
});

test("refreshes status on demand and renders ahead and behind counts", async ({ page }) => {
  const errors = collectPageErrors(page);
  prepareGitState(PROJECT_ONE, "alpha", "ahead");
  await openApp(page);
  await expect(page.locator("#git-upstream")).toContainText("1 ahead");

  prepareGitState(PROJECT_ONE, "alpha", "behind");
  await page.locator("#git-refresh").click();
  await expect(page.locator("#git-upstream")).toContainText("1 behind");

  prepareGitState(PROJECT_ONE, "alpha", "clean");
  await page.locator("#git-refresh").click();
  await expect(page.locator("#git-upstream")).toContainText("origin/main");
  await expect(page.locator("#git-upstream")).not.toContainText("behind");
  await expect(page.locator("#git-upstream")).not.toContainText("ahead");

  await settle(page);
  expectNoPageErrors(errors);
});

test("commits every change group and updates the last commit", async ({ page }) => {
  const errors = collectPageErrors(page);
  prepareGitState(PROJECT_ONE, "beta", "dirty");
  await signIn(page, BETA_PATH);
  await expect(page.getByRole("heading", { name: "beta", exact: true })).toBeVisible();

  await page.locator("#git-commit-message").fill("E2E commit from SPA");
  await page.locator("#git-commit").click();

  await expect(toast(page, "Committed as")).toBeVisible();
  await expect(page.locator("#repository-card")).toContainText("Clean");
  await expect(page.locator("#git-clean")).toContainText("Working tree clean");
  await expect(page.locator("#git-commit-form")).toHaveCount(0);
  await expect(page.locator("#last-commit-card")).toContainText("E2E commit from SPA");

  await settle(page);
  expectNoPageErrors(errors);
});

test("fetches, updates, pushes, and switches branches", async ({ page }) => {
  const errors = collectPageErrors(page);
  prepareGitState(PROJECT_ONE, "alpha", "behind");
  await openApp(page);
  await expect(page.locator("#git-upstream")).toContainText("1 behind");

  await page.locator("#git-fetch").click();
  await expect(toast(page, "Fetched all remotes.")).toBeVisible();
  await expect(page.locator("#git-upstream")).toContainText("1 behind");

  await page.locator("#git-update").click();
  await expect(toast(page, "Branch updated to")).toBeVisible();
  await expect(page.locator("#git-upstream")).not.toContainText("behind");
  await expect(page.locator("#repository-card")).toContainText("Clean");

  prepareGitState(PROJECT_ONE, "alpha", "ahead");
  await page.locator("#git-refresh").click();
  await expect(page.locator("#git-upstream")).toContainText("1 ahead");
  await page.locator("#git-push").click();
  await expect(toast(page, "Pushed to origin/main.")).toBeVisible();
  await expect(page.locator("#git-upstream")).not.toContainText("ahead");

  await page.locator("#git-branch-select").selectOption("feature");
  await page.locator("#git-switch").click();
  await expect(toast(page, "Switched to feature.")).toBeVisible();
  await expect(page.locator("#git-branch")).toContainText("feature");

  await page.locator("#git-switch").click();
  await expect(page.locator("#git-notice")).toContainText("You are already on feature.");

  await settle(page);
  expectNoPageErrors(errors);
});

test("maps git action and status failures to the legacy messages", async ({ page }) => {
  prepareGitState(PROJECT_ONE, "alpha", "clean");
  await openApp(page);

  await page.route(/\/git\/push$/, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "push rejected upstream", code: "push_rejected" }),
    }),
  );
  await page.locator("#git-push").click();
  await expect(
    toast(
      page,
      "The remote has commits you do not have. Fetch and update the branch, then try again.",
    ),
  ).toBeVisible();
  await expect(page.locator("#git-notice")).toContainText("Push rejected");
  await page.unroute(/\/git\/push$/);

  await page.route(/\/git\/update$/, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "diverged", code: "diverged" }),
    }),
  );
  await page.locator("#git-update").click();
  await expect(
    toast(page, "The branch has diverged from its upstream. Reconcile it in the IDE."),
  ).toBeVisible();
  await expect(page.locator("#git-notice")).toContainText("Update stopped");
  await page.unroute(/\/git\/update$/);

  await page.route(/\/git\/status$/, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "coordinator unavailable", code: "git_failed" }),
    }),
  );
  await page.locator("#git-refresh").click();
  await expect(page.locator("#repository-card")).toContainText("Repository status unavailable");
  await expect(page.locator("#repository-card")).toContainText("coordinator unavailable");
  await page.unroute(/\/git\/status$/);
  await page.locator("#repository-card").getByRole("button", { name: "Retry" }).click();
  await expect(page.locator("#repository-card")).toContainText("Clean");
});

test("validates the commit message and warns before switching to the current branch", async ({
  page,
}) => {
  prepareGitState(PROJECT_ONE, "beta", "dirty");
  await signIn(page, BETA_PATH);
  await expect(page.getByRole("heading", { name: "beta", exact: true })).toBeVisible();

  let commits = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/git/commit")) {
      commits += 1;
    }
  });
  await page.locator("#git-commit").click();
  await expect(page.locator("#git-commit-error")).toContainText("A message is required");
  expect(commits).toBe(0);

  prepareGitState(PROJECT_ONE, "alpha", "clean");
  await page.goto(APP_PATH);
  await expect(page.getByRole("heading", { name: "alpha", exact: true })).toBeVisible();
  await page.locator("#git-branch-select").selectOption("main");
  await page.locator("#git-switch").click();
  await expect(page.locator("#git-notice")).toContainText("You are already on main.");
});
